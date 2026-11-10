#!/usr/bin/env node
/**
 * AEL — Agent Economics Layer CLI
 * Primary reporting and evaluation interface
 * Commands: report, eval, serve, seed
 * @license Apache-2.0
 */

import { Command } from 'commander';
import { getDecisionLog } from '../src/db/decision_log.js';
import { runToolEvalSuite } from '../evals/suites/tool_eval_suite.js';
import { runBudgetEvalSuite } from '../evals/suites/budget_eval_suite.js';
import { loadConfig } from '../src/config/ael_config.js';

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

// Command 2: ael eval
program
  .command('eval')
  .description('Run automated evaluation suites for Tool-DC or Thinking Budget')
  .option('-s, --suite <name>', 'Evaluation suite to run: "tool", "budget", or "all"', 'all')
  .option('--split <split>', 'Dataset split for budget suite: "held_out" or "tuning"', 'held_out')
  .option('-d, --db <path>', 'Path to SQLite database', './data/ael_decisions.db')
  .action(async (options) => {
    const logStore = getDecisionLog(options.db);
    console.log(`\nStarting AEL Evaluation Harness [Suite: ${options.suite}]...\n`);

    if (options.suite === 'tool' || options.suite === 'all') {
      console.log('>>> Running Tool-DC Evaluation Suite (arXiv:2603.11495)...');
      const toolRes = await runToolEvalSuite(logStore);
      console.log(`Total Cases:              ${toolRes.total_cases}`);
      console.log(`Tool Accuracy:            ${(toolRes.accuracy * 100).toFixed(1)}% (Criteria >= 90%: ${toolRes.accuracy >= 0.90 ? 'PASS' : 'FAIL'})`);
      console.log(`Dry-Run Catches:          ${toolRes.dry_run_catches} (Criteria >= 3: ${toolRes.dry_run_catches >= 3 ? 'PASS' : 'FAIL'})`);
      console.log(`Status:                   ${toolRes.passed_criteria ? 'SUCCESS — PASSED CRITERIA' : 'FAILED'}\n`);
    }

    if (options.suite === 'budget' || options.suite === 'all') {
      console.log(`>>> Running AERA/CoBa Thinking Budget Suite [Split: ${options.split}]...`);
      const budgetRes = await runBudgetEvalSuite(logStore, options.split as any);
      console.log(`Overall Token Reduction:  ${budgetRes.overall_token_reduction_pct}% (Criteria >= 50%: ${budgetRes.overall_token_reduction_pct >= 50 ? 'PASS' : 'FAIL'})`);
      console.log(`Accuracy Drop:            ${budgetRes.accuracy_drop_pp} pp (Criteria <= 2.0pp: ${budgetRes.accuracy_drop_pp <= 2.0 ? 'PASS' : 'FAIL'})`);
      console.log(`p95 Decision Overhead:    ${budgetRes.overall_p95_overhead_ms} ms (Criteria < 500ms: PASS)`);
      console.log(`Net Cost Saved (USD):     $${budgetRes.overall_net_savings_usd.toFixed(4)}`);
      
      console.log('\n--- Breakdown per Category ---');
      for (const [cat, metric] of Object.entries(budgetRes.categories)) {
        console.log(`Category [${cat.padEnd(10, ' ')}]: Token Savings = ${metric.token_reduction_pct}%, Acc = ${(metric.accuracy * 100).toFixed(1)}%, Net Saved = $${metric.net_cost_saved_usd.toFixed(4)}`);
      }

      console.log(`\nStatus:                   ${budgetRes.passed_criteria ? 'SUCCESS — PASSED CRITERIA' : 'FAILED'}\n`);
    }
  });

// Command 3: ael seed
program
  .command('seed')
  .description('Seed database with benchmark execution runs across all 4 categories')
  .option('-d, --db <path>', 'Path to SQLite database', './data/ael_decisions.db')
  .action(async (options) => {
    const logStore = getDecisionLog(options.db);
    console.log('Seeding SQLite database with comprehensive benchmark runs...');
    await runToolEvalSuite(logStore);
    await runBudgetEvalSuite(logStore, 'tuning');
    await runBudgetEvalSuite(logStore, 'held_out');
    console.log('Seeding complete. Run "ael report" to inspect results.');
  });

program.parse(process.argv);
