/**
 * Extended Unit Tests: Tool-DC Engine (Cache Invalidation & Retries)
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../src/mcp/registry.js';
import { DryRunSandbox } from '../src/mcp/sandbox.js';
import { ToolDCEngine } from '../src/engines/tool_dc.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { FILESYSTEM_TOOLS, MockFilesystemServer } from '../evals/mock_servers/filesystem_server.js';
import { SEARCH_TOOLS, MockSearchServer } from '../evals/mock_servers/search_server.js';
import { DESTRUCTIVE_TOOLS, MockDestructiveServer } from '../evals/mock_servers/destructive_server.js';

describe('Tool-DC Extended Features', () => {
  let registry: ToolRegistry;
  let sandbox: DryRunSandbox;
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let engine: ToolDCEngine;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
    registry = new ToolRegistry([...FILESYSTEM_TOOLS, ...SEARCH_TOOLS, ...DESTRUCTIVE_TOOLS]);
    sandbox = new DryRunSandbox();
    const fs = new MockFilesystemServer();
    const search = new MockSearchServer();
    const destructive = new MockDestructiveServer();
    sandbox.registerExecutor('filesystem', (n, a, d) => fs.execute(n, a, d));
    sandbox.registerExecutor('search', (n, a, d) => search.execute(n, a, d));
    sandbox.registerExecutor('destructive', (n, a, d) => destructive.execute(n, a, d));

    logStore = new DecisionLogStore(':memory:');
    llm = new LLMClient({
      name: 'mock',
      type: 'mock',
      api_key_env: 'KEY',
      default_model: 'mock',
      cheap_model: 'mock',
      reasoning_model: 'mock',
      supports_reasoning_effort: true,
      supports_logprobs: true,
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
    });

    engine = new ToolDCEngine(registry, sandbox, llm, logStore);
  });

  it('serves subsequent identical queries from cache when schema_hash matches', async () => {
    const query = 'Read file documentation from /workspace/README.md';

    // First call (uncached)
    const res1 = await engine.selectAndExecute(query);
    expect(res1.cached).toBe(false);
    expect(res1.success).toBe(true);

    // Second call (cached)
    const res2 = await engine.selectAndExecute(query);
    expect(res2.cached).toBe(true);
    expect(res2.tool_name).toBe(res1.tool_name);
    expect(res2.overhead_tokens).toBe(0);
  });

  it('invalidates cache automatically when tool registry changes schema_hash', async () => {
    const query = 'Read file documentation from /workspace/README.md';

    const res1 = await engine.selectAndExecute(query);
    expect(res1.cached).toBe(false);

    // Invalidate toolset by registering a new tool
    registry.registerTool({
      name: 'new_custom_tool',
      description: 'A newly added tool',
      parameters: {},
      server: 'custom',
      dry_run_support: 'simulated',
      side_effect: 'none',
      reversible: true,
      requires_human_approval: false,
    });

    // Third call must miss cache due to schema_hash update
    const res3 = await engine.selectAndExecute(query);
    expect(res3.cached).toBe(false);
  });

  it('supports pass-through mode in Tool-DC', async () => {
    const res = await engine.selectAndExecute('Search docs for pricing', { pass_through: true });
    expect(res.success).toBe(true);
    expect(res.dry_run).toBeNull();
  });

  it('enforces dry-run and side-effect safety policy on cache hits for mutating tools (P0-11)', async () => {
    const dryRunSpy = vi.spyOn(sandbox, 'evaluateDryRun');
    const executeSpy = vi.spyOn(sandbox, 'executeLive');
    const query = 'Transfer $50 from account acc_001 to acc_002';

    // 1. First call populates cache for mutating tool with explicit human approval
    const first = await engine.selectAndExecute(query, { human_approval_granted: true });
    expect(first.cached).toBe(false);
    expect(first.success).toBe(true);
    expect(first.tool_name).toBe('fin_transfer_funds');
    expect(first.dry_run?.mode).toBe('schema_only');
    expect(first.dry_run?.executed).toBe(false);
    expect(first.dry_run?.passed).toBe(false);
    expect(first.dry_run?.reason).toBe('not_executed_dry_run_unsupported');
    expect(dryRunSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // 2. Second call hits cache WITHOUT human approval -> MUST still run dry-run check and block live mutation
    const secondBlocked = await engine.selectAndExecute(query, { human_approval_granted: false });
    expect(secondBlocked.cached).toBe(true);
    expect(secondBlocked.tool_name).toBe('fin_transfer_funds');
    expect(secondBlocked.dry_run).not.toBeNull();
    expect(secondBlocked.dry_run?.mode).toBe('schema_only');
    expect(secondBlocked.dry_run?.executed).toBe(false);
    expect(secondBlocked.dry_run?.passed).toBe(false);
    expect(secondBlocked.dry_run?.reason).toBe('not_executed_dry_run_unsupported');
    expect(secondBlocked.dry_run?.authorization_required).toBe(true);
    expect(secondBlocked.dry_run?.authorization_granted).toBe(false);
    expect(secondBlocked.success).toBe(false);
    expect(secondBlocked.error).toContain('requires human approval');
    expect(dryRunSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy).toHaveBeenCalledTimes(2);

    // 3. Cached idempotent/real-dry-run tool whose underlying precondition fails on 2nd call MUST be caught before live execution
    let allowExecution = true;
    registry.registerTool({
      name: 'idempotent_sync_record',
      description: 'Synchronize record idempotently with pre-flight dry-run validation',
      parameters: { type: 'object', properties: { record_id: { type: 'string' } }, required: ['record_id'] },
      server: 'idempotent_srv',
      dry_run_support: 'real',
      side_effect: 'idempotent',
      reversible: true,
      requires_human_approval: false,
    });
    sandbox.registerExecutor('idempotent_srv', async (_name, _args, isDryRun) => {
      if (!allowExecution) {
        throw new Error('PreconditionFailed: Target state locked');
      }
      return { ok: true, dry_run: isDryRun };
    });
    vi.spyOn(llm, 'complete').mockResolvedValueOnce({
      text: JSON.stringify({ tool: 'idempotent_sync_record', arguments: { record_id: 'rec_1' } }),
      input_tokens: 10,
      output_tokens: 10,
      reasoning_tokens: 0,
      total_tokens: 20,
      cost_usd: 0.00001,
      latency_ms: 5,
      model: 'mock',
      confidence_source: 'unavailable',
      provider_source: 'mock_simulator',
    });

    const sync1 = await engine.selectAndExecute('Sync idempotent record rec_1');
    expect(sync1.cached).toBe(false);
    expect(sync1.success).toBe(true);

    // Underlying condition changes so dry-run now fails; cache hit MUST run dry-run and NOT call executeLive
    allowExecution = false;
    const callsBeforeBlockedSync = executeSpy.mock.calls.length;
    const sync2 = await engine.selectAndExecute('Sync idempotent record rec_1');
    expect(sync2.cached).toBe(true);
    expect(sync2.success).toBe(false);
    expect(sync2.dry_run?.executed).toBe(true);
    expect(sync2.dry_run?.passed).toBe(false);
    expect(sync2.error).toContain('PreconditionFailed');
    expect(executeSpy.mock.calls.length).toBe(callsBeforeBlockedSync);
  });
});
