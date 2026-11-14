/**
 * AEL — Agent Economics Layer
 * Definition of Done (DoD) Verification Gate
 *
 * Enforces CI hardening rules (STEERING.md §4 C-1):
 * (a) Eval thresholds missed -> non-zero exit
 * (b) Magic-number grep lint on src/ with explicit allowlist
 * (c) README.md claims vs evals/results/ verbatim consistency
 * (d) Mock contamination check (provider_source vs NOT VALIDATED labels)
 * (e) Coverage gate: src/engines >= 80% statements
 *
 * @license Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function fail(section: string, message: string): never {
  console.error(`[verify-dod FAIL][${section}] ${message}`);
  process.exit(1);
}

function pass(section: string, message: string): void {
  console.log(`[verify-dod PASS][${section}] ${message}`);
}

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ============================================================================
// (b) Magic-number grep lint on src/ with explicit test/file allowlist
// ============================================================================
function checkMagicNumbers(): void {
  const srcDir = path.join(ROOT_DIR, 'src');
  const allowlistedFiles = new Set<string>([
    // Test directories live outside src/, and specific allowlisted paths can be listed here if ever needed
  ]);

  const forbiddenPatterns: Array<{ name: string; regex: RegExp; fileFilter?: (rel: string) => boolean }> = [
    { name: 'hardcoded logprob_confidence 0.88', regex: /\b0\.88\b/ },
    { name: 'hardcoded baseline tokens 3500', regex: /\b3500\b/ },
    { name: 'hardcoded baseline cost 0.0035', regex: /\b0\.0035\b/ },
    { name: 'hardcoded fallback latency (: 8)', regex: /:\s*8\b/ },
    { name: 'fabricated overhead heuristic (* 0.35)', regex: /latency\s*\*\s*0\.35/i },
    {
      name: 'externally_verified in budget.ts',
      regex: /externally_verified/,
      fileFilter: (rel) => rel === 'src/engines/budget.ts',
    },
    {
      name: 'hardcoded 800/120 baseline constants in budget.ts',
      regex: /\b(800|120)\b/,
      fileFilter: (rel) => rel === 'src/engines/budget.ts',
    },
  ];

  const files = walkTsFiles(srcDir);
  const violations: string[] = [];

  for (const file of files) {
    const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
    if (rel.startsWith('tests/') || allowlistedFiles.has(rel)) continue;

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const pattern of forbiddenPatterns) {
        if (pattern.fileFilter && !pattern.fileFilter(rel)) continue;
        if (pattern.regex.test(line)) {
          violations.push(`${rel}:${idx + 1} matched ${pattern.name}: ${line.trim()}`);
        }
      }
    });
  }

  if (violations.length > 0) {
    fail('magic-numbers', `Forbidden hardcoded evidence values detected in src/:\n${violations.join('\n')}`);
  }
  pass('magic-numbers', `Scanned ${files.length} source files in src/ with 0 violations.`);
}

// ============================================================================
// (a) Eval thresholds + (c) README verbatim consistency + (d) Mock contamination
// ============================================================================
function checkEvalsAndReadme(): void {
  const readmePath = path.join(ROOT_DIR, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fail('readme', 'README.md not found.');
  }
  const readme = fs.readFileSync(readmePath, 'utf8');

  const resultsDir = path.join(ROOT_DIR, 'evals', 'results');
  if (!fs.existsSync(resultsDir)) {
    fail('evals', 'evals/results directory not found.');
  }

  // Extract evals/results/*.json files referenced by README.md
  const referencedMatches = Array.from(readme.matchAll(/evals\/results\/([A-Za-z0-9._-]+\.json)/g)).map(m => m[1]);
  const referencedFiles = Array.from(new Set(referencedMatches));

  const toolFile = referencedFiles.find(f => f.includes('tool_selection'));
  const budgetFile = referencedFiles.find(f => f.includes('budget_held_out'));

  if (!toolFile || !budgetFile) {
    fail('readme-consistency', `README.md must reference both tool_selection and budget_held_out JSON files in evals/results/. Found: ${referencedFiles.join(', ')}`);
  }

  for (const file of referencedFiles) {
    const full = path.join(resultsDir, file);
    if (!fs.existsSync(full)) {
      fail('readme-consistency', `README.md references missing result file: evals/results/${file}`);
    }
  }

  // Validate all result files in evals/results/ for thresholds (a) and mock contamination (d)
  const allResultFiles = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));
  for (const file of allResultFiles) {
    const full = path.join(resultsDir, file);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));

    // (d) Mock contamination check
    if (!data.provider_source || !data.acceptance_status) {
      fail('mock-contamination', `evals/results/${file} is missing provider_source or acceptance_status.`);
    }
    const isMock = data.provider_source === 'mock_simulator' || String(data.provider_source).includes('mock') || !data.live_api_credentials_present;
    if (isMock && !String(data.acceptance_status).startsWith('NOT VALIDATED')) {
      fail('mock-contamination', `evals/results/${file} used '${data.provider_source}' (live=${data.live_api_credentials_present}) but acceptance_status is '${data.acceptance_status}' instead of NOT VALIDATED.`);
    }

    // (a) Eval thresholds check
    if (file.includes('tool_selection')) {
      if (typeof data.accuracy !== 'number' || data.accuracy < 0.90) {
        fail('eval-thresholds', `${file}: tool selection accuracy ${data.accuracy} < 0.90`);
      }
      if (typeof data.dry_run_catches !== 'number' || data.dry_run_catches < 3) {
        fail('eval-thresholds', `${file}: dry_run_catches ${data.dry_run_catches} < 3`);
      }
      if (!data.passed_criteria) {
        fail('eval-thresholds', `${file}: passed_criteria is false`);
      }
    } else if (file.includes('budget_held_out')) {
      if (typeof data.overall_token_reduction_pct !== 'number' || data.overall_token_reduction_pct < 50.0) {
        fail('eval-thresholds', `${file}: overall_token_reduction_pct ${data.overall_token_reduction_pct}% < 50.0%`);
      }
      if (typeof data.accuracy_drop_pp !== 'number' || data.accuracy_drop_pp > 2.0) {
        fail('eval-thresholds', `${file}: accuracy_drop_pp ${data.accuracy_drop_pp} > 2.0`);
      }
      if (typeof data.overall_p95_overhead_ms !== 'number' || data.overall_p95_overhead_ms >= 500) {
        fail('eval-thresholds', `${file}: overall_p95_overhead_ms ${data.overall_p95_overhead_ms} >= 500`);
      }
    }
  }
  pass('eval-thresholds', `All ${allResultFiles.length} result files pass numeric threshold checks.`);

  // (c) Verbatim consistency between README.md and the referenced JSON files
  const toolJson = JSON.parse(fs.readFileSync(path.join(resultsDir, toolFile), 'utf8'));
  const budgetJson = JSON.parse(fs.readFileSync(path.join(resultsDir, budgetFile), 'utf8'));

  const toolAccPct = `${(toolJson.accuracy * 100).toFixed(1)}%`;
  const mustContainInReadme: Array<{ label: string; token: string }> = [
    { label: 'tool execution_date', token: String(toolJson.execution_date) },
    { label: 'tool accuracy % + ratio', token: `${toolAccPct} (${toolJson.selection_accuracy_ratio})` },
    { label: 'tool dry-run catches ratio', token: `${toolJson.dry_run_catch_ratio} catches` },
    { label: 'tool avg retries', token: `${toolJson.average_retries} retries` },
    { label: 'budget execution_date', token: String(budgetJson.execution_date) },
    { label: 'budget overall token reduction', token: `**${budgetJson.overall_token_reduction_pct}%** (\`${budgetJson.overall_token_reduction_ratio}\`)` },
    { label: 'budget overall baseline tokens', token: Number(budgetJson.overall_baseline_tokens).toLocaleString('en-US') },
    { label: 'budget overall actual tokens', token: Number(budgetJson.overall_actual_tokens).toLocaleString('en-US') },
    { label: 'budget overall net savings', token: `+$${Number(budgetJson.overall_net_savings_usd).toFixed(5)}` },
    { label: 'budget usd_per_task_baseline', token: `$${Number(budgetJson.usd_per_task_baseline).toFixed(5)}` },
    { label: 'budget usd_per_task_ael', token: `$${Number(budgetJson.usd_per_task_ael).toFixed(5)}` },
    { label: 'budget overall p95 overhead', token: `**${budgetJson.overall_p95_overhead_ms} ms**` },
    { label: 'budget overall baseline accuracy ratio', token: String(budgetJson.overall_baseline_accuracy_ratio) },
    { label: 'budget overall accuracy ratio', token: String(budgetJson.overall_accuracy_ratio) },
  ];

  for (const [cat, m] of Object.entries<any>(budgetJson.categories || {})) {
    mustContainInReadme.push(
      { label: `${cat} baseline tokens`, token: Number(m.baseline_tokens).toLocaleString('en-US') },
      { label: `${cat} actual tokens`, token: Number(m.actual_tokens).toLocaleString('en-US') },
      { label: `${cat} token reduction %`, token: `**${m.token_reduction_pct}%** (\`${m.token_reduction_ratio}\`)` },
      { label: `${cat} net savings`, token: `+$${Number(m.net_cost_saved_usd).toFixed(5)}` },
      { label: `${cat} baseline accuracy ratio`, token: String(m.baseline_accuracy_ratio) },
      { label: `${cat} accuracy ratio`, token: String(m.accuracy_ratio) },
    );
  }

  for (const item of mustContainInReadme) {
    if (!readme.includes(item.token)) {
      fail('readme-consistency', `README.md is missing verbatim metric [${item.label}]: expected "${item.token}"`);
    }
  }

  // Verify mock contamination rule on README DoD table rows #1-#5
  const readmeLines = readme.split(/\r?\n/);
  const dodRows = readmeLines.filter(l => /^\|\s*\*\*#[1-5]\*\*\s*\|/.test(l));
  if (dodRows.length !== 5) {
    fail('mock-contamination', `Expected 5 DoD rows (#1-#5) in README.md, found ${dodRows.length}.`);
  }

  const toolIsMock = toolJson.provider_source === 'mock_simulator' || !toolJson.live_api_credentials_present;
  const budgetIsMock = budgetJson.provider_source === 'mock_simulator' || !budgetJson.live_api_credentials_present;

  for (const row of dodRows) {
    const isToolRow = row.includes('#1') || row.includes('#2');
    const isBudgetRow = row.includes('#3') || row.includes('#4') || row.includes('#5');
    if ((isToolRow && toolIsMock) || (isBudgetRow && budgetIsMock)) {
      const cells = row.split('|').map(c => c.trim());
      const statusCell = cells[cells.length - 2] || '';
      if (!statusCell.includes('NOT VALIDATED') || /\*\*PASS\*\*/.test(statusCell)) {
        fail('mock-contamination', `Mock-backed DoD row in README.md must be labeled NOT VALIDATED (not PASS): ${row}`);
      }
    }
  }

  pass('readme-consistency', `README.md matches ${toolFile} & ${budgetFile} verbatim across all ratios and figures.`);
  pass('mock-contamination', 'Provider sources and NOT VALIDATED labels are strictly aligned.');
}

// ============================================================================
// (e) Coverage gate: src/engines >= 80% statements
// ============================================================================
function checkEnginesCoverage(): void {
  const summaryPath = path.join(ROOT_DIR, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) {
    fail('coverage-gate', `Missing coverage summary at ${summaryPath}. Run vitest with --coverage.reporter=json-summary first.`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const engineEntries = Object.entries<any>(summary).filter(([file]) =>
    file.replace(/\\/g, '/').includes('/src/engines/')
  );

  if (engineEntries.length === 0) {
    fail('coverage-gate', 'No files found under /src/engines/ in coverage-summary.json.');
  }

  let totalStatements = 0;
  let coveredStatements = 0;
  for (const [file, metrics] of engineEntries) {
    const stmts = metrics?.statements;
    if (!stmts || typeof stmts.total !== 'number' || typeof stmts.covered !== 'number') {
      fail('coverage-gate', `Invalid statement metrics for ${file}`);
    }
    totalStatements += stmts.total;
    coveredStatements += stmts.covered;
  }

  const pct = totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0;
  if (pct < 80.0) {
    fail('coverage-gate', `src/engines statement coverage ${pct.toFixed(2)}% < 80.0% (${coveredStatements}/${totalStatements}).`);
  }

  pass('coverage-gate', `src/engines statement coverage = ${pct.toFixed(2)}% (${coveredStatements}/${totalStatements} >= 80.0%).`);
}

function main(): void {
  console.log('=== AEL verify-dod CI Gate ===');
  checkMagicNumbers();
  checkEvalsAndReadme();
  checkEnginesCoverage();
  console.log('=== All verify-dod gates PASSED ===');
}

main();
