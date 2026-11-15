#!/usr/bin/env node
/**
 * AEL — Agent Economics Layer CLI
 * Primary reporting and evaluation interface
 * Commands: report, eval, seed
 * @license Apache-2.0
 */

import { Command } from 'commander';
import { getDecisionLog } from '../src/db/decision_log.js';
import { runToolEvalSuite, projectToolEvalCost } from '../evals/suites/tool_eval_suite.js';
import { runBudgetEvalSuite, projectBudgetEvalCost } from '../evals/suites/budget_eval_suite.js';
import {
  LiveProviderType,
  MAX_LIVE_EVAL_COST_USD,
  assertWithinSpendingGuard,
  resolveLiveProviderProfile,
} from '../evals/suites/spending_guard.js';

const program = new Command();
program
  .name('ael')
  .description('Agent Economics Layer — Self-hosted economic middleware for AI agents')
  .version('0.1.0');

// Command 1: ael report
program
  .command('report')
  .description('Print comprehensive economic savings and accuracy report')
  .option('-d, --db <path>', 'Path to SQLite database', './data/ael_decisions.db')
  .action((options) => {
    const logStore = getDecisionLog(options.db);
    const summary = logStore.getSummary();

    console.log('\n================================================================');
    console.log('              AEL — AGENT ECONOMICS LAYER REPORT                 ');
    console.log('================================================================\n');

    console.log('--- EXECUTIVE SAVINGS SUMMARY ---');
    console.log(`Total Requests Processed:     ${summary.total_requests}`);
    console.log(`Successful Tasks:             ${summary.successful_tasks}`);
    console.log(`Net Tokens Saved:             ${summary.total_net_tokens_saved.toLocaleString()} (${summary.percent_tokens_saved}% reduction vs baseline)`);
    console.log(`Net Cost Saved (USD):         $${summary.total_net_cost_saved_usd.toFixed(4)} (${summary.percent_cost_saved}% net savings)`);
    console.log(`USD / Completed Task (Base):  $${summary.usd_per_completed_task_baseline.toFixed(5)}`);
    console.log(`USD / Completed Task (AEL):   $${summary.usd_per_completed_task_ael.toFixed(5)}`);

    console.log('\n--- TOOL SELECTION ENGINE (Tool-DC) ---');
    console.log(`Tool Selection Accuracy:      ${(summary.tool_selection_accuracy * 100).toFixed(1)}%`);
    console.log(`Dry-Run Catches Count:        ${summary.dry_run_catches_count}`);
    console.log(`Average Reflection Retries:   ${summary.average_retries}`);

    console.log('\n--- LATENCY & MIDDLEWARE OVERHEAD ---');
    console.log(`p50 Request Latency:          ${summary.p50_latency_ms} ms`);
    console.log(`p95 Request Latency:          ${summary.p95_latency_ms} ms`);
    console.log(`p95 AEL Decision Overhead:    ${summary.p95_ael_overhead_ms} ms (Contract < 500ms: ${summary.p95_ael_overhead_ms < 500 ? 'PASS' : 'FAIL'})`);

    console.log('\n--- ESCALATION TIER DISTRIBUTION ---');
    for (const [effort, count] of Object.entries(summary.escalation_distribution)) {
      console.log(`  Tier [${effort.padEnd(6, ' ')}]: ${count}`);
    }

    console.log('\n--- CONFIDENCE SIGNAL TAXONOMY ---');
    for (const [signal, count] of Object.entries(summary.confidence_distribution)) {
      console.log(`  Signal [${signal.padEnd(20, ' ')}]: ${count}`);
    }

    if (summary.circuit_breaker_tripped_workflows.length > 0) {
      console.log('\n[!] CIRCUIT BREAKER TRIPPED WORKFLOWS:');
      for (const wf of summary.circuit_breaker_tripped_workflows) {
        console.log(`  - ${wf}`);
      }
    } else {
      console.log('\nCircuit Breakers: All workflows healthy (0 tripped).');
    }

    console.log('\n================================================================\n');
  });

// Command 2: ael eval (Live Provider Evaluation ONLY)
program
  .command('eval')
  .description('Run live provider evaluation suites for Tool-DC or Thinking Budget (requires live API credentials)')
  .option('-s, --suite <name>', 'Evaluation suite to run: "tool", "budget", or "all"', 'all')
  .option('--split <split>', 'Dataset split for budget suite: "held_out" or "tuning"', 'held_out')
  .option('-d, --db <path>', 'Path to SQLite database', './data/ael_decisions.db')
  .option('--provider <provider>', 'Live provider override: "gemini", "openai", or "anthropic"')
  .option('--live', 'Explicit live flag (evaluation is always live; retained for CLI compatibility)', true)
  .option('--limit <n>', 'Cap tasks per category for a run (0 or omitted runs full dataset)')
  .option('--model <model>', 'Override live model identifier (e.g. gemini-2.5-flash-lite, gpt-4o-mini)')
  .option('--max-cost-usd <usd>', 'Spending guard cap in USD (aborts if projected cost exceeds cap)', String(MAX_LIVE_EVAL_COST_USD))
  .option('--preflight-only', 'Validate live credentials and projected cost spending guard without executing API calls', false)
  .action(async (options) => {
    const maxCostUsd = Number(options.maxCostUsd);
    const split = (options.split || 'held_out') as 'held_out' | 'tuning';
    const providerOpt = options.provider ? (String(options.provider).trim() as LiveProviderType) : undefined;
    const model: string | undefined = options.model ? String(options.model).trim() : undefined;

    let limit: number | undefined;
    if (options.limit !== undefined && String(options.limit).trim() !== '') {
      const parsedLimit = Number(options.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 0) {
        throw new Error(`[AEL Eval] Invalid --limit '${options.limit}': expected a non-negative integer.`);
      }
      limit = parsedLimit > 0 ? parsedLimit : undefined;
    }

    // Fail fast if live provider credentials are missing or invalid (never fall back to mock)
    const { profile } = resolveLiveProviderProfile({ provider: providerOpt, model });

    let projectedTotalUsd = 0;
    if (options.suite === 'tool' || options.suite === 'all') {
      projectedTotalUsd += projectToolEvalCost(profile, limit).projectedCostUsd;
    }
    if (options.suite === 'budget' || options.suite === 'all') {
      projectedTotalUsd += projectBudgetEvalCost(split, profile, limit).projectedCostUsd;
    }

    assertWithinSpendingGuard(projectedTotalUsd, maxCostUsd, `eval(${options.suite}):preflight`);
    console.log(
      `[Live Credential & Spending Guard PASS] Provider: ${profile.type}, Model: ${profile.default_model}, Projected max cost: $${projectedTotalUsd.toFixed(6)} <= $${maxCostUsd.toFixed(2)} cap.`
    );
    if (options.preflightOnly) {
      return;
    }

    const logStore = getDecisionLog(options.db);
    console.log(
      `\nStarting AEL Live Evaluation [Suite: ${options.suite}, Provider: ${profile.type}, Model: ${profile.default_model}${limit ? `, Limit: ${limit}/cat` : ''}]...\n`
    );

    if (options.suite === 'tool' || options.suite === 'all') {
      console.log('>>> Running Tool-DC Evaluation Suite (arXiv:2603.11495)...');
      const toolRes = await runToolEvalSuite(logStore, {
        provider: profile.type as LiveProviderType,
        maxCostUsd,
        limit,
        model: profile.default_model,
      });
      const toolFile = `${toolRes.execution_date}_live_tool_selection.json`;
      console.log(`Source / Provider:        ${toolRes.source} / ${toolRes.provider} (${toolRes.credential_status})`);
      console.log(`Dataset / Hash:           ${toolRes.dataset_version} (${toolRes.dataset_hash.slice(0, 12)}...)`);
      console.log(`Total Cases:              ${toolRes.total_cases} (${toolRes.selection_cases_total} selection + ${toolRes.dry_run_catch_cases_total} dry-run catch, valid=${toolRes.sample_size.valid_samples})`);
      console.log(`Model / Sample Cap:       ${toolRes.model} (limit=${toolRes.sample_size.limit_per_category ?? 'none'})`);
      console.log(`Tool Accuracy:            ${(toolRes.accuracy * 100).toFixed(1)}% (${toolRes.selection_accuracy_ratio}, Criteria >= 90%: ${toolRes.accuracy >= 0.90 ? 'PASS' : 'FAIL'})`);
      console.log(`Dry-Run Catches:          ${toolRes.dry_run_catches} (${toolRes.dry_run_catch_ratio}, Criteria >= 3: ${toolRes.dry_run_catches >= 3 ? 'PASS' : 'FAIL'})`);
      console.log(`Actual Token Usage:       ${toolRes.token_usage.ael_total_tokens} (in=${toolRes.token_usage.ael_input_tokens}, out=${toolRes.token_usage.ael_output_tokens}, reason=${toolRes.token_usage.ael_reasoning_tokens})`);
      console.log(`Evidence File:            evals/results/${toolFile}`);
      console.log(`Acceptance Status:        ${toolRes.acceptance_status}\n`);
      if (!toolRes.passed_criteria) {
        process.exitCode = 1;
      }
    }

    if (options.suite === 'budget' || options.suite === 'all') {
      console.log(`>>> Running AERA/CoBa Thinking Budget Suite [Split: ${split}]...`);
      const budgetRes = await runBudgetEvalSuite(logStore, split, {
        provider: profile.type as LiveProviderType,
        maxCostUsd,
        limit,
        model: profile.default_model,
      });
      const budgetFile = `${budgetRes.execution_date}_live_budget_${split}.json`;
      console.log(`Source / Provider:        ${budgetRes.source} / ${budgetRes.provider} (${budgetRes.credential_status})`);
      console.log(`Dataset / Hash:           ${budgetRes.dataset_version} (${budgetRes.dataset_hash.slice(0, 12)}...)`);
      console.log(`Model / Sample Size:      ${budgetRes.model} (${budgetRes.sample_size.valid_samples}/${budgetRes.sample_size.full_dataset_queries} valid, limit=${budgetRes.sample_size.limit_per_category ?? 'none'})`);
      console.log(`Baseline Accuracy:        ${(budgetRes.baseline_accuracy * 100).toFixed(1)}% (${budgetRes.overall_baseline_accuracy_ratio})`);
      console.log(`AEL Accuracy:             ${(budgetRes.overall_accuracy * 100).toFixed(1)}% (${budgetRes.overall_accuracy_ratio})`);
      console.log(`Accuracy Drop:            ${budgetRes.accuracy_drop_pp} pp`);
      console.log(`p95 Decision Overhead:    ${budgetRes.overall_p95_overhead_ms} ms (Criteria < 500ms: ${budgetRes.overall_p95_overhead_ms < 500 ? 'PASS' : 'FAIL'})`);
      if (budgetRes.savings_claims_valid) {
        console.log(`Overall Token Reduction:  ${budgetRes.overall_token_reduction_pct}% (${budgetRes.overall_token_reduction_ratio})`);
        console.log(`Net Cost Saved (USD):     $${budgetRes.overall_net_savings_usd!.toFixed(4)} (${budgetRes.cost_methodology.billing_basis})`);
      } else {
        console.log(`Overall Token Reduction:  NOT CLAIMED (evaluation failed: ${budgetRes.acceptance_status})`);
        console.log(`Net Cost Saved (USD):     NOT CLAIMED (evaluation failed: ${budgetRes.acceptance_status})`);
      }
      console.log(`Verification Cost (Judge):$${budgetRes.verification_cost.toFixed(6)} (disclosed separately from product costs)`);

      console.log('\n--- Breakdown per Category ---');
      for (const [cat, metric] of Object.entries(budgetRes.categories)) {
        const savingsStr =
          metric.net_cost_saved_usd !== null
            ? `Token Savings = ${metric.token_reduction_pct}% (${metric.token_reduction_ratio}), Net Saved = $${metric.net_cost_saved_usd.toFixed(4)}`
            : 'Savings = NOT CLAIMED (evaluation failed)';
        console.log(
          `Category [${cat.padEnd(10, ' ')}]: N=${metric.total_samples} [${metric.verification_method}], BaseAcc = ${(metric.baseline_accuracy * 100).toFixed(1)}% (${metric.baseline_accuracy_ratio}), AELAcc = ${(metric.accuracy * 100).toFixed(1)}% (${metric.accuracy_ratio}), ${savingsStr}`
        );
      }

      console.log(`\nEvidence File:            evals/results/${budgetFile}`);
      console.log(`Acceptance DoD Status:    ${budgetRes.acceptance_status}\n`);
      if (budgetRes.acceptance_status !== 'PASS') {
        process.exitCode = 1;
      }
    }
  });

// Command 3: ael seed
program
  .command('seed')
  .description('Run live evaluation suites to populate SQLite decision log (requires live API credentials)')
  .option('-d, --db <path>', 'Path to SQLite database', './data/ael_decisions.db')
  .option('--provider <provider>', 'Live provider override: "gemini", "openai", or "anthropic"')
  .option('--limit <n>', 'Cap tasks per category', '5')
  .action(async (options) => {
    const providerOpt = options.provider ? (String(options.provider).trim() as LiveProviderType) : undefined;
    resolveLiveProviderProfile({ provider: providerOpt });
    const limit = Number(options.limit) > 0 ? Number(options.limit) : undefined;
    const logStore = getDecisionLog(options.db);
    console.log('Running live evaluation suites to populate SQLite decision log...');
    await runToolEvalSuite(logStore, { provider: providerOpt, limit });
    await runBudgetEvalSuite(logStore, 'tuning', { provider: providerOpt, limit });
    console.log('Seeding complete. Run "ael report" to inspect results.');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
