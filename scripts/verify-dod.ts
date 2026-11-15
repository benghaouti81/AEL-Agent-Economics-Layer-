/**
 * AEL — Agent Economics Layer
 * Definition of Done (DoD) Verification Gate
 *
 * Enforces CI & benchmark integrity rules:
 * (a) Zero mock simulator contamination across runtime, CLI, eval suites, results, and README
 * (b) Magic-number & token-estimation fallback lint on src/ and server.ts
 * (c) Every artifact in evals/results/ must be a valid "live_provider" benchmark passing validateBenchmarkResult()
 * (d) README.md consistency (no mock figures, DoD #1-#5 must be NOT RUN / NOT VALIDATED unless live artifacts exist)
 * (e) Coverage gate: src/engines >= 80% statements
 * (f) Staleness gate when live evals/results/ artifacts exist
 *
 * When no live evaluation artifacts exist in evals/results/ (e.g. standard CI without live keys),
 * live evaluations are reported as SKIPPED / NOT RUN — never simulated or marked PASS.
 *
 * @license Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBenchmarkResult } from '../evals/suites/benchmark_validator.js';

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

function skip(section: string, message: string): void {
  console.log(`[verify-dod SKIPPED][${section}] ${message}`);
}

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
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
// (a) No mock simulator paths in runtime, CLI, eval suites, server, or examples
// ============================================================================
function checkNoMockSimulator(): void {
  const targetDirs = [
    path.join(ROOT_DIR, 'src'),
    path.join(ROOT_DIR, 'bin'),
    path.join(ROOT_DIR, 'evals', 'suites'),
    path.join(ROOT_DIR, 'examples'),
  ];
  const files = [
    ...targetDirs.flatMap(d => walkTsFiles(d)),
    path.join(ROOT_DIR, 'server.ts'),
  ].filter(f => fs.existsSync(f));

  const forbiddenMockPatterns: Array<{ name: string; regex: RegExp }> = [
    { name: 'mock_simulator source', regex: /mock_simulator/ },
    { name: 'mockGenerate simulator method', regex: /mockGenerate/ },
    { name: 'AEL_ALLOW_MOCK bypass flag', regex: /AEL_ALLOW_MOCK/ },
    { name: 'mock provider type literal', regex: /type:\s*['"]mock['"]/ },
  ];

  const violations: string[] = [];
  for (const file of files) {
    const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const p of forbiddenMockPatterns) {
        if (p.regex.test(line)) {
          violations.push(`${rel}:${idx + 1} matched ${p.name}: ${line.trim()}`);
        }
      }
    });
  }

  if (violations.length > 0) {
    fail('no-mock-simulator', `Mock simulator references detected in production/eval code:\n${violations.join('\n')}`);
  }
  pass('no-mock-simulator', `Scanned ${files.length} production/eval files with 0 mock simulator references.`);
}

// ============================================================================
// (b) Magic-number & token-estimation fallback grep lint
// ============================================================================
function checkMagicNumbers(): void {
  const srcDir = path.join(ROOT_DIR, 'src');
  const files = [...walkTsFiles(srcDir), path.join(ROOT_DIR, 'server.ts')].filter(f => fs.existsSync(f));

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
    {
      name: 'fabricated token length/4 fallback in llm client or server',
      regex: /Math\.ceil\([^)]*\.length\s*\/\s*4\)/,
      fileFilter: (rel) => rel === 'src/llm/client.ts' || rel === 'server.ts',
    },
  ];

  const violations: string[] = [];
  for (const file of files) {
    const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
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
    fail('magic-numbers', `Forbidden hardcoded evidence or token-estimation values detected:\n${violations.join('\n')}`);
  }
  pass('magic-numbers', `Scanned ${files.length} source files with 0 violations.`);
}

// ============================================================================
// (c) & (d) Live-only evals/results verification + README integrity
// ============================================================================
function checkEvalsAndReadme(): string[] {
  const readmePath = path.join(ROOT_DIR, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fail('readme', 'README.md not found.');
  }
  const readme = fs.readFileSync(readmePath, 'utf8');

  // Ensure README has zero mock benchmark claims
  const forbiddenReadmeTokens = ['mock_simulator', 'AEL_ALLOW_MOCK'];
  for (const tok of forbiddenReadmeTokens) {
    if (readme.includes(tok)) {
      fail('readme-integrity', `README.md contains forbidden mock reference '${tok}'.`);
    }
  }

  const resultsDir = path.join(ROOT_DIR, 'evals', 'results');
  const allResultFiles = fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'))
    : [];

  // Every JSON artifact present in evals/results/ MUST pass strict live benchmark validation
  for (const file of allResultFiles) {
    const full = path.join(resultsDir, file);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    const validation = validateBenchmarkResult(data, { requirePassingAcceptance: true });
    if (!validation.valid) {
      fail('benchmark-evidence', `evals/results/${file} failed benchmark integrity validation:\n- ${validation.errors.join('\n- ')}`);
    }
  }

  const readmeLines = readme.split(/\r?\n/);
  const dodRows = readmeLines.filter(l => /^\|\s*\*\*#[1-5]\*\*\s*\|/.test(l));
  if (dodRows.length !== 5) {
    fail('readme-integrity', `Expected 5 DoD rows (#1-#5) in README.md, found ${dodRows.length}.`);
  }

  if (allResultFiles.length === 0) {
    // No live benchmark artifacts in repository: DoD #1-#5 must NOT claim PASS
    for (const row of dodRows) {
      const cells = row.split('|').map(c => c.trim());
      const statusCell = cells[cells.length - 2] || '';
      if (/\*\*PASS\*\*/.test(statusCell) || (!statusCell.includes('NOT RUN') && !statusCell.includes('NOT VALIDATED'))) {
        fail('readme-integrity', `DoD row without live evaluation artifacts cannot be marked PASS in README.md: ${row}`);
      }
    }
    skip('live-evals', 'Live evaluation: NOT RUN / SKIPPED (no live provider result artifacts in evals/results/; live provider credentials required).');
    pass('readme-integrity', 'README.md DoD rows #1-#5 honestly report NOT RUN without mock figures.');
    return allResultFiles;
  }

  // When live benchmark artifacts exist, enforce verbatim README traceability
  const referencedMatches = Array.from(readme.matchAll(/evals\/results\/([A-Za-z0-9._-]+\.json)/g)).map(m => m[1]);
  const referencedFiles = Array.from(new Set(referencedMatches));
  const toolFile = referencedFiles.find(f => f.includes('tool_selection'));
  const budgetFile = referencedFiles.find(f => f.includes('budget_held_out'));

  if (!toolFile || !budgetFile) {
    fail('readme-consistency', `Live results exist, so README.md must reference both live tool_selection and budget_held_out JSON files. Found: ${referencedFiles.join(', ')}`);
  }

  for (const file of referencedFiles) {
    if (!fs.existsSync(path.join(resultsDir, file))) {
      fail('readme-consistency', `README.md references missing result file: evals/results/${file}`);
    }
  }

  pass('benchmark-evidence', `All ${allResultFiles.length} live result file(s) passed strict benchmark validation.`);
  return allResultFiles;
}

// ============================================================================
// (f) Staleness gate (active whenever live result artifacts exist)
// ============================================================================
function checkResultsFreshness(resultFiles: string[]): void {
  if (resultFiles.length === 0) {
    skip('results-staleness', 'No live result artifacts present; staleness check skipped.');
    return;
  }

  const resultsDir = path.join(ROOT_DIR, 'evals', 'results');
  let latestCodeCommitRaw = '';
  try {
    latestCodeCommitRaw = execFileSync(
      'git',
      ['log', '-1', '--format=%ct %h', '--', 'src/', 'evals/', ':(exclude)evals/results/'],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    ).trim();
  } catch (err: any) {
    fail('results-staleness', `Unable to query git history for src/ and evals/: ${err?.message || String(err)}`);
  }

  if (!latestCodeCommitRaw) {
    pass('results-staleness', 'No git history available for src/evals.');
    return;
  }

  const [latestCodeTsStr, latestCodeSha] = latestCodeCommitRaw.split(/\s+/);
  const latestCodeTs = Number(latestCodeTsStr);

  for (const file of resultFiles) {
    const full = path.join(resultsDir, file);
    const rel = `evals/results/${file}`;
    const fileCommitRaw = execFileSync(
      'git',
      ['log', '-1', '--format=%ct %h', '--', rel],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    ).trim();

    if (fileCommitRaw) {
      const [fileTsStr, fileSha] = fileCommitRaw.split(/\s+/);
      const fileTs = Number(fileTsStr);
      if (fileTs < latestCodeTs) {
        fail(
          'results-staleness',
          `${rel} (commit ${fileSha}, ts=${fileTs}) is older than latest src/evals code commit (${latestCodeSha}, ts=${latestCodeTs}). Regenerate live eval results.`
        );
      }
    } else {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const parsedMs = data?.timestamp ? Date.parse(String(data.timestamp)) : NaN;
      const fileTs = Number.isFinite(parsedMs)
        ? Math.floor(parsedMs / 1000)
        : Math.floor(fs.statSync(full).mtimeMs / 1000);
      if (fileTs < latestCodeTs) {
        fail(
          'results-staleness',
          `Untracked ${rel} (ts=${fileTs}) is older than latest src/evals code commit (${latestCodeSha}, ts=${latestCodeTs}).`
        );
      }
    }
  }

  pass('results-staleness', `All ${resultFiles.length} live result file(s) are fresh relative to ${latestCodeSha}.`);
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
  checkNoMockSimulator();
  checkMagicNumbers();
  const resultFiles = checkEvalsAndReadme();
  checkResultsFreshness(resultFiles);
  checkEnginesCoverage();
  console.log('=== All verify-dod gates PASSED ===');
}

main();
