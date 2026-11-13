/**
 * Unit Tests: Tool-DC Engine & Dry-Run Sandbox
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/mcp/registry.js';
import { DryRunSandbox } from '../src/mcp/sandbox.js';
import { ToolDCEngine } from '../src/engines/tool_dc.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { FILESYSTEM_TOOLS, MockFilesystemServer } from '../evals/mock_servers/filesystem_server.js';
import { DESTRUCTIVE_TOOLS, MockDestructiveServer } from '../evals/mock_servers/destructive_server.js';

describe('Tool-DC Engine & Dry-Run Sandbox', () => {
  let registry: ToolRegistry;
  let sandbox: DryRunSandbox;
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let engine: ToolDCEngine;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
    registry = new ToolRegistry([...FILESYSTEM_TOOLS, ...DESTRUCTIVE_TOOLS]);
    sandbox = new DryRunSandbox();
    const fsServer = new MockFilesystemServer();
    const destServer = new MockDestructiveServer();
    sandbox.registerExecutor('filesystem', (name, args, dry) => fsServer.execute(name, args, dry));
    sandbox.registerExecutor('destructive', (name, args, dry) => destServer.execute(name, args, dry));

    logStore = new DecisionLogStore(':memory:');
    llm = new LLMClient({
      name: 'mock',
      type: 'mock',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'mock',
      cheap_model: 'mock',
      reasoning_model: 'mock',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
    });
    engine = new ToolDCEngine(registry, sandbox, llm, logStore);
  });

  it('selects and verifies a valid tool call successfully', async () => {
    const res = await engine.selectAndExecute('Read the contents of /workspace/README.md');
    expect(res.success).toBe(true);
    expect(res.tool_name).toBe('fs_read_file');
    expect(res.retries).toBeLessThanOrEqual(3);
  });

  it('prohibits dry-run execution on mutating tools', async () => {
    const mutatingTool = registry.getTool('fin_transfer_funds')!;
    const dryRun = await sandbox.evaluateDryRun(mutatingTool, { source_account: '1', target_account: '2', amount_usd: 10 }, false);
    expect(dryRun.executed).toBe(false);
    expect(dryRun.mode).toBe('schema_only');
  });

  it('blocks live execution on mutating tool requiring human approval without explicit confirmation', async () => {
    const destructiveTool = registry.getTool('fin_transfer_funds')!;
    const liveWithoutApproval = await sandbox.executeLive(destructiveTool, { source_account: '1', target_account: '2', amount_usd: 10 }, false);
    expect(liveWithoutApproval.success).toBe(false);
    expect(liveWithoutApproval.error).toContain('requires human approval');

    const liveWithApproval = await sandbox.executeLive(destructiveTool, { source_account: '1', target_account: '2', amount_usd: 10 }, true);
    expect(liveWithApproval.success).toBe(true);
  });

  it('catches non-existent files during real safe dry-run before live execution', async () => {
    const readFileTool = registry.getTool('fs_read_file')!;
    const dryRun = await sandbox.evaluateDryRun(readFileTool, { path: '/workspace/not_exist.txt' }, false);
    expect(dryRun.executed).toBe(true);
    expect(dryRun.passed).toBe(false);
    expect(dryRun.error).toContain('FileNotFoundError');
  });

  it('computes baseline_tokens and baseline_cost_usd dynamically from registry schemas and provider pricing', async () => {
    const expectedTokens1 = Math.ceil(JSON.stringify(registry.getAllTools()).length / 4);
    const expectedCost1 = llm.calculateCost(expectedTokens1, 0, 0);

    const res1 = await engine.selectAndExecute('Read the contents of /workspace/README.md');
    expect(res1.baseline_tokens).toBe(expectedTokens1);
    expect(res1.baseline_cost_usd).toBe(expectedCost1);

    registry.registerTool({
      name: 'extra_analytics_query',
      description: 'Run a comprehensive multi-table aggregation across historical telemetry logs for auditing.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'ISO 8601 start date' },
          end_date: { type: 'string', description: 'ISO 8601 end date' },
        },
        required: ['start_date', 'end_date'],
      },
      server: 'analytics',
      dry_run_support: 'simulated',
      side_effect: 'none',
      reversible: true,
      requires_human_approval: false,
    });

    const expectedTokens2 = Math.ceil(JSON.stringify(registry.getAllTools()).length / 4);
    const expectedCost2 = llm.calculateCost(expectedTokens2, 0, 0);

    const res2 = await engine.selectAndExecute('Read the contents of /workspace/README.md');
    expect(expectedTokens2).toBeGreaterThan(expectedTokens1);
    expect(res2.baseline_tokens).toBe(expectedTokens2);
    expect(res2.baseline_cost_usd).toBe(expectedCost2);
    expect(res2.baseline_cost_usd).toBeGreaterThan(res1.baseline_cost_usd);
  });
});
