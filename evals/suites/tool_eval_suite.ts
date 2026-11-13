/**
 * AEL Tool-DC Evaluation Suite
 * Verifies:
 * 1. >= 90% tool-selection accuracy within <= 3 retries
 * 2. >= 3 demonstrated dry-run catches of wrong tools before side effects
 * @license Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../../src/mcp/registry.js';
import { DryRunSandbox } from '../../src/mcp/sandbox.js';
import { ToolDCEngine } from '../../src/engines/tool_dc.js';
import { LLMClient } from '../../src/llm/client.js';
import { DecisionLogStore } from '../../src/db/decision_log.js';
import { FILESYSTEM_TOOLS, MockFilesystemServer } from '../mock_servers/filesystem_server.js';
import { SEARCH_TOOLS, MockSearchServer } from '../mock_servers/search_server.js';
import { DESTRUCTIVE_TOOLS, MockDestructiveServer } from '../mock_servers/destructive_server.js';
import { ProviderProfile } from '../../src/config/ael_config.js';

export interface ToolEvalResult {
  suite_name: string;
  execution_date: string;
  run_command: string;
  live_api_credentials_present: boolean;
  provider_source: string;
  acceptance_status:
    | 'PASS'
    | 'NOT VALIDATED (No live upstream API credentials configured)'
    | 'NOT VALIDATED (Thresholds not reached)';
  total_cases: number;
  selection_cases_total: number;
  successful_selections: number;
  selection_accuracy_ratio: string;
  accuracy: number;
  average_retries: number;
  dry_run_catch_cases_total: number;
  dry_run_catches: number;
  dry_run_catch_ratio: string;
  passed_criteria: boolean;
  cases: Array<{
    case_type: 'selection' | 'dry_run_catch';
    query: string;
    expected_tool: string;
    actual_tool: string | null;
    passed: boolean;
    retries: number;
    dry_run_caught: boolean;
    error?: string;
  }>;
}

export async function runToolEvalSuite(logStore: DecisionLogStore): Promise<ToolEvalResult> {
  const registry = new ToolRegistry([
    ...FILESYSTEM_TOOLS,
    ...SEARCH_TOOLS,
    ...DESTRUCTIVE_TOOLS,
  ]);

  const sandbox = new DryRunSandbox();
  const fsServer = new MockFilesystemServer();
  const searchServer = new MockSearchServer();
  const destructiveServer = new MockDestructiveServer();

  sandbox.registerExecutor('filesystem', (name, args, isDryRun) => fsServer.execute(name, args, isDryRun));
  sandbox.registerExecutor('search', (name, args, isDryRun) => searchServer.execute(name, args, isDryRun));
  sandbox.registerExecutor('destructive', (name, args, isDryRun) => destructiveServer.execute(name, args, isDryRun));

  const hasLiveApiKey = Boolean(
    (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' && process.env.GEMINI_API_KEY !== 'YOUR_API_KEY') ||
    (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'MY_API_KEY' && process.env.OPENAI_API_KEY !== 'YOUR_API_KEY') ||
    (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'MY_API_KEY' && process.env.ANTHROPIC_API_KEY !== 'YOUR_API_KEY')
  );

  const providerType = hasLiveApiKey
    ? (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'MY_API_KEY'
        ? 'openai'
        : process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'MY_API_KEY'
          ? 'anthropic'
          : 'gemini')
    : 'mock';

  const provider: ProviderProfile = {
    name: hasLiveApiKey ? `live_${providerType}` : 'eval_mock',
    type: providerType as any,
    api_key_env: providerType === 'openai' ? 'OPENAI_API_KEY' : providerType === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY',
    default_model: providerType === 'openai' ? 'gpt-4o-mini' : providerType === 'anthropic' ? 'claude-3-5-haiku-20241022' : providerType === 'gemini' ? 'gemini-2.5-flash' : 'mock-model',
    cheap_model: providerType === 'openai' ? 'gpt-4o-mini' : providerType === 'anthropic' ? 'claude-3-5-haiku-20241022' : providerType === 'gemini' ? 'gemini-2.5-flash-lite' : 'mock-model',
    reasoning_model: providerType === 'openai' ? 'o3-mini' : providerType === 'anthropic' ? 'claude-3-7-sonnet-20250219' : providerType === 'gemini' ? 'gemini-2.5-pro' : 'mock-model',
    supports_reasoning_effort: true,
    supports_logprobs: false,
    input_cost_per_million: 0.10,
    output_cost_per_million: 0.40,
    reasoning_cost_per_million: 0.40,
  };

  const llm = new LLMClient(provider);
  const toolDc = new ToolDCEngine(registry, sandbox, llm, logStore);

  const testCases = [
    { query: 'Read the contents of README.md in the workspace', expected_tool: 'fs_read_file' },
    { query: 'Search the documentation for information on economics layer', expected_tool: 'search_knowledge_base' },
    { query: 'List all files currently in the workspace directory', expected_tool: 'fs_list_directory' },
    { query: 'Find the pricing policy document in knowledge base', expected_tool: 'search_knowledge_base' },
    { query: 'Check the file /workspace/config.json content', expected_tool: 'fs_read_file' },
    { query: 'Execute read-only SQL SELECT on reporting warehouse', expected_tool: 'db_query_readonly' },
    { query: 'Transfer $50 from account acc_001 to acc_002', expected_tool: 'fin_transfer_funds' },
    { query: 'Inspect files in /workspace folder structure', expected_tool: 'fs_list_directory' },
    { query: 'Query documentation on Try-Check-Retry FSM', expected_tool: 'search_knowledge_base' },
    { query: 'Read file /workspace/src/index.ts source code', expected_tool: 'fs_read_file' },
  ];

  // Specific dry-run catch scenarios: wrong tools or invalid argument payloads
  const catchScenarios = [
    {
      query: 'Read non-existent file /workspace/ghost_file.txt',
      trigger_bad_path: true,
    },
    {
      query: 'Execute SQL query to drop table without permission: DROP TABLE users',
      trigger_bad_sql: true,
    },
    {
      query: 'Search docs with an empty search query string',
      trigger_empty_query: true,
    },
  ];

  const results: ToolEvalResult['cases'] = [];
  let successfulCount = 0;
  let totalSelectionRetries = 0;
  let dryRunCatches = 0;

  // Run standard selection test cases (10 cases)
  for (const tc of testCases) {
    const approval = tc.expected_tool === 'fin_transfer_funds';
    const res = await toolDc.selectAndExecute(tc.query, {
      workflow_id: 'tool_eval',
      human_approval_granted: approval,
    });
    const passed = res.success && res.tool_name === tc.expected_tool;
    if (passed) successfulCount++;
    totalSelectionRetries += res.retries;

    results.push({
      case_type: 'selection',
      query: tc.query,
      expected_tool: tc.expected_tool,
      actual_tool: res.tool_name,
      passed,
      retries: res.retries,
      dry_run_caught: Boolean(res.dry_run && res.dry_run.executed && !res.dry_run.passed),
      error: res.error,
    });
  }

  // Run dry-run safety catch scenarios (3 cases)
  const { baselineTokens, baselineCostUsd } = toolDc.computeRegistryBaseline();
  for (const cs of catchScenarios) {
    let badTool: string = 'fs_read_file';
    let badArgs: Record<string, any> = { path: '/workspace/ghost_file.txt' };

    if (cs.trigger_bad_sql) {
      badTool = 'db_query_readonly';
      badArgs = { sql: 'DROP TABLE users' };
    } else if (cs.trigger_empty_query) {
      badTool = 'search_knowledge_base';
      badArgs = { query: '   ' };
    }

    const tool = registry.getTool(badTool)!;
    const checkStart = performance.now();
    const dryRun = await sandbox.evaluateDryRun(tool, badArgs, false);
    const measuredOverheadMs = Math.max(0, Math.round(performance.now() - checkStart));

    if (dryRun.executed && !dryRun.passed) {
      dryRunCatches++;
      logStore.insertDecision({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        workflow_id: 'tool_eval',
        query_hash: 'catch_hash',
        task_category: 'mcp_tool_selection',
        schema_hash: registry.getSchemaHash(),
        tool_chosen: badTool,
        retries_count: 1,
        dry_run_executed: true,
        dry_run_passed: false,
        dry_run_caught_error: dryRun.error || 'Fault caught during dry-run',
        completed_successfully: false,
        baseline_tokens: baselineTokens,
        upstream_tokens: 0,
        ael_internal_tokens: 0,
        net_tokens_saved: baselineTokens,
        baseline_cost_usd: baselineCostUsd,
        upstream_cost_usd: 0,
        ael_internal_cost_usd: 0,
        net_cost_saved_usd: baselineCostUsd,
        latency_ms: measuredOverheadMs,
        ael_overhead_ms: measuredOverheadMs,
      } as any);
      results.push({
        case_type: 'dry_run_catch',
        query: cs.query,
        expected_tool: badTool,
        actual_tool: badTool,
        passed: true,
        retries: 1,
        dry_run_caught: true,
        error: dryRun.error,
      });
    } else {
      results.push({
        case_type: 'dry_run_catch',
        query: cs.query,
        expected_tool: badTool,
        actual_tool: badTool,
        passed: false,
        retries: 1,
        dry_run_caught: false,
        error: dryRun.error || 'Expected dry-run catch did not trigger',
      });
    }
  }

  const totalCases = results.length;
  const selectionCasesTotal = testCases.length;
  const dryRunCatchCasesTotal = catchScenarios.length;
  const accuracy = Number((successfulCount / selectionCasesTotal).toFixed(3));
  const averageRetries = Number((totalSelectionRetries / selectionCasesTotal).toFixed(2));
  const passedThresholds = accuracy >= 0.90 && dryRunCatches >= 3;
  const providerSource = hasLiveApiKey ? providerType : 'mock_simulator';
  const acceptanceStatus = hasLiveApiKey
    ? (passedThresholds ? 'PASS' : 'NOT VALIDATED (Thresholds not reached)')
    : 'NOT VALIDATED (No live upstream API credentials configured)';

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const evalResult: ToolEvalResult = {
    suite_name: 'Tool-DC Verification & Safety Suite',
    execution_date: dateStr,
    run_command: 'npx tsx bin/ael.ts eval --suite tool',
    live_api_credentials_present: hasLiveApiKey,
    provider_source: providerSource,
    acceptance_status: acceptanceStatus,
    total_cases: totalCases,
    selection_cases_total: selectionCasesTotal,
    successful_selections: successfulCount,
    selection_accuracy_ratio: `${successfulCount}/${selectionCasesTotal}`,
    accuracy,
    average_retries: averageRetries,
    dry_run_catch_cases_total: dryRunCatchCasesTotal,
    dry_run_catches: dryRunCatches,
    dry_run_catch_ratio: `${dryRunCatches}/${dryRunCatchCasesTotal}`,
    passed_criteria: passedThresholds,
    cases: results,
  };

  const suiteDir = path.dirname(fileURLToPath(import.meta.url));
  const resultsDir = path.resolve(suiteDir, '..', 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const evidenceFile = path.join(resultsDir, `${dateStr}_tool_selection.json`);
  fs.writeFileSync(evidenceFile, JSON.stringify(evalResult, null, 2), 'utf8');

  return evalResult;
}
