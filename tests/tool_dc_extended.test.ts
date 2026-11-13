/**
 * Extended Unit Tests: Tool-DC Engine (Cache Invalidation & Retries)
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/mcp/registry.js';
import { DryRunSandbox } from '../src/mcp/sandbox.js';
import { ToolDCEngine } from '../src/engines/tool_dc.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { FILESYSTEM_TOOLS, MockFilesystemServer } from '../evals/mock_servers/filesystem_server.js';
import { SEARCH_TOOLS, MockSearchServer } from '../evals/mock_servers/search_server.js';

describe('Tool-DC Extended Features', () => {
  let registry: ToolRegistry;
  let sandbox: DryRunSandbox;
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let engine: ToolDCEngine;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
    registry = new ToolRegistry([...FILESYSTEM_TOOLS, ...SEARCH_TOOLS]);
    sandbox = new DryRunSandbox();
    const fs = new MockFilesystemServer();
    const search = new MockSearchServer();
    sandbox.registerExecutor('filesystem', (n, a, d) => fs.execute(n, a, d));
    sandbox.registerExecutor('search', (n, a, d) => search.execute(n, a, d));

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
});
