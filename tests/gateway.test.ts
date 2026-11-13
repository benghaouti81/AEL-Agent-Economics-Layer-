/**
 * Unit Tests: MCP Gateway & Meta-Tools Surface
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/mcp/registry.js';
import { DryRunSandbox } from '../src/mcp/sandbox.js';
import { ToolDCEngine } from '../src/engines/tool_dc.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { McpGateway } from '../src/mcp/gateway.js';
import { FILESYSTEM_TOOLS, MockFilesystemServer } from '../evals/mock_servers/filesystem_server.js';
import { SEARCH_TOOLS, MockSearchServer } from '../evals/mock_servers/search_server.js';
import { DESTRUCTIVE_TOOLS, MockDestructiveServer } from '../evals/mock_servers/destructive_server.js';
import { ProviderProfile } from '../src/config/ael_config.js';

describe('McpGateway Surface', () => {
  let gateway: McpGateway;
  let registry: ToolRegistry;
  let sandbox: DryRunSandbox;
  let logStore: DecisionLogStore;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
    registry = new ToolRegistry([...FILESYSTEM_TOOLS, ...SEARCH_TOOLS, ...DESTRUCTIVE_TOOLS]);
    sandbox = new DryRunSandbox();
    const fs = new MockFilesystemServer();
    const search = new MockSearchServer();
    const dest = new MockDestructiveServer();
    sandbox.registerExecutor('filesystem', (n, a, d) => fs.execute(n, a, d));
    sandbox.registerExecutor('search', (n, a, d) => search.execute(n, a, d));
    sandbox.registerExecutor('destructive', (n, a, d) => dest.execute(n, a, d));

    logStore = new DecisionLogStore(':memory:');
    const provider: ProviderProfile = {
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
    };
    const llm = new LLMClient(provider);
    const toolDc = new ToolDCEngine(registry, sandbox, llm, logStore);
    gateway = new McpGateway(registry, sandbox, toolDc, logStore, provider);
  });

  it('discovers tools without parameter bloat', () => {
    const all = gateway.discoverTools();
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all[0]).toHaveProperty('name');
    expect(all[0]).toHaveProperty('side_effect');
    expect(all[0]).not.toHaveProperty('parameters');

    const filtered = gateway.discoverTools('filesystem read file');
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('retrieves detailed schema and execution contract via get_tool_schema', () => {
    const schema = gateway.getToolSchema('fs_read_file');
    expect(schema.name).toBe('fs_read_file');
    expect(schema.parameters).toBeDefined();
    expect(schema.contract.dry_run_support).toBe('real');
    expect(schema.contract.side_effect).toBe('none');

    expect(() => gateway.getToolSchema('non_existent')).toThrow();
  });

  it('executes tool with validation and authorization checks via execute_tool', async () => {
    const result = await gateway.executeTool('fs_read_file', { path: '/workspace/README.md' });
    expect(result.success).toBe(true);
    expect(result.result.content).toContain('Agent Economics Layer');

    await expect(gateway.executeTool('fs_read_file', { missing_path: true } as any)).rejects.toThrow();
  });

  it('runs smart_action end-to-end via Tool-DC engine', async () => {
    const res = await gateway.smartAction('Read /workspace/README.md documentation');
    expect(res.success).toBe(true);
    expect(res.tool_name).toBe('fs_read_file');
  });
});
