/**
 * Unit Tests: LLM Client & Provider Adapters
 * @license Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { LLMClient } from '../src/llm/client.js';

describe('LLMClient Adapter Layer', () => {
  it('calculates dollar costs accurately across token types and pricing tables', () => {
    const client = new LLMClient({
      name: 'test_provider',
      type: 'mock',
      api_key_env: 'KEY',
      default_model: 'test-model',
      cheap_model: 'cheap-model',
      reasoning_model: 'reasoning-model',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 1.0,
      output_cost_per_million: 2.0,
      reasoning_cost_per_million: 3.0,
    });

    const cost = client.calculateCost(1_000_000, 1_000_000, 1_000_000);
    expect(cost).toBe(6.0);
  });

  it('generates simulated responses for tool selection and verification in offline mode', async () => {
    const client = new LLMClient({
      name: 'offline_mock',
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

    // Tool selection prompt
    const toolRes = await client.complete(
      'SELECT TOOL AND ARGUMENTS for this user task:\n"Execute SQL SELECT query on database warehouse"'
    );
    expect(toolRes.text).toContain('db_query_readonly');
    expect(toolRes.provider_source).toBe('mock_simulator');

    // Verification prompt
    const verifyRes = await client.complete('EVALUATE EVIDENCE AND RESOLVE QUERY: check stability');
    expect(verifyRes.text).toContain('verified');

    // Generic prompt with effort scaling
    const highEffortRes = await client.complete('Complex analysis', { reasoning_effort: 'high' });
    expect(highEffortRes.reasoning_tokens).toBe(600);

    const medEffortRes = await client.complete('Medium analysis', { reasoning_effort: 'medium' });
    expect(medEffortRes.reasoning_tokens).toBe(250);
  });

  it('warns and degrades gracefully when reasoning effort is unsupported by provider profile', async () => {
    const client = new LLMClient({
      name: 'unsupported_provider',
      type: 'mock',
      api_key_env: 'KEY',
      default_model: 'mock',
      cheap_model: 'mock',
      reasoning_model: 'mock',
      supports_reasoning_effort: false, // Knob unsupported
      supports_logprobs: false,
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
    });

    // Must not throw or crash
    const res = await client.complete('Query with unsupported knob', { reasoning_effort: 'high' });
    expect(res).toBeDefined();
    expect(res.total_tokens).toBeGreaterThan(0);
  });
});
