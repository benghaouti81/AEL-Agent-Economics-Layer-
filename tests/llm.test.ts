/**
 * Unit Tests: LLM Client & Provider Adapters
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LLMClient } from '../src/llm/client.js';

describe('LLMClient Adapter Layer', () => {
  const originalAllowMock = process.env.AEL_ALLOW_MOCK;
  const originalOpenAIKey = process.env.TEST_OPENAI_KEY;
  const originalAnthropicKey = process.env.TEST_ANTHROPIC_KEY;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAllowMock === undefined) {
      delete process.env.AEL_ALLOW_MOCK;
    } else {
      process.env.AEL_ALLOW_MOCK = originalAllowMock;
    }
    if (originalOpenAIKey === undefined) {
      delete process.env.TEST_OPENAI_KEY;
    } else {
      process.env.TEST_OPENAI_KEY = originalOpenAIKey;
    }
    if (originalAnthropicKey === undefined) {
      delete process.env.TEST_ANTHROPIC_KEY;
    } else {
      process.env.TEST_ANTHROPIC_KEY = originalAnthropicKey;
    }
  });

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

  it('rejects mock_simulator unless AEL_ALLOW_MOCK=1 is explicitly set', async () => {
    delete process.env.AEL_ALLOW_MOCK;
    const client = new LLMClient({
      name: 'offline_mock',
      type: 'mock',
      api_key_env: 'KEY',
      default_model: 'mock',
      cheap_model: 'mock',
      reasoning_model: 'mock',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
    });

    await expect(client.complete('hello')).rejects.toThrow(/AEL_ALLOW_MOCK=1/);
  });

  it('throws on missing credentials or adapter failure without silent mock fallback', async () => {
    process.env.AEL_ALLOW_MOCK = '1';

    const openaiMissingKey = new LLMClient({
      name: 'openai_no_key',
      type: 'openai',
      api_key_env: 'TEST_OPENAI_KEY',
      default_model: 'gpt-4o-mini',
      cheap_model: 'gpt-4o-mini',
      reasoning_model: 'o3-mini',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.15,
      output_cost_per_million: 0.60,
      reasoning_cost_per_million: 0.60,
    });
    await expect(openaiMissingKey.complete('hello')).rejects.toThrow(/Missing API key/);

    process.env.TEST_OPENAI_KEY = 'sk-test-123';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'upstream unavailable',
    }));
    await expect(openaiMissingKey.complete('hello')).rejects.toThrow(/OpenAI HTTP 503/);

    process.env.TEST_ANTHROPIC_KEY = 'ant-test-123';
    const anthropicClient = new LLMClient({
      name: 'anthropic_fail',
      type: 'anthropic',
      api_key_env: 'TEST_ANTHROPIC_KEY',
      default_model: 'claude-3-5-haiku-20241022',
      cheap_model: 'claude-3-5-haiku-20241022',
      reasoning_model: 'claude-3-7-sonnet-20250219',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.15,
      output_cost_per_million: 0.60,
      reasoning_cost_per_million: 0.60,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    }));
    await expect(anthropicClient.complete('hello')).rejects.toThrow(/Anthropic HTTP 502/);
  });

  it('generates simulated responses for tool selection and verification in offline mode when AEL_ALLOW_MOCK=1', async () => {
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
    expect(verifyRes.provider_source).toBe('mock_simulator');

    // Generic prompt with effort scaling
    const highEffortRes = await client.complete('Complex analysis', { reasoning_effort: 'high' });
    expect(highEffortRes.reasoning_tokens).toBe(600);
    expect(highEffortRes.provider_source).toBe('mock_simulator');
    expect(highEffortRes.confidence_source).toBe('unavailable');
    expect(highEffortRes.logprob_confidence).toBeUndefined();

    const medEffortRes = await client.complete('Medium analysis', { reasoning_effort: 'medium' });
    expect(medEffortRes.reasoning_tokens).toBe(250);
    expect(medEffortRes.provider_source).toBe('mock_simulator');
    expect(medEffortRes.confidence_source).toBe('unavailable');
    expect(medEffortRes.logprob_confidence).toBeUndefined();
  });

  it('omits logprob_confidence and sets confidence_source=unavailable when providers lack logprobs, and uses real logprobs when present', async () => {
    process.env.TEST_OPENAI_KEY = 'sk-test-123';
    const openaiClient = new LLMClient({
      name: 'openai_conf_test',
      type: 'openai',
      api_key_env: 'TEST_OPENAI_KEY',
      default_model: 'gpt-4o-mini',
      cheap_model: 'gpt-4o-mini',
      reasoning_model: 'o3-mini',
      supports_reasoning_effort: true,
      supports_logprobs: true,
      input_cost_per_million: 0.15,
      output_cost_per_million: 0.60,
      reasoning_cost_per_million: 0.60,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    }));
    const noLogprobsRes = await openaiClient.complete('hello');
    expect(noLogprobsRes.provider_source).toBe('openai');
    expect(noLogprobsRes.confidence_source).toBe('unavailable');
    expect(noLogprobsRes.logprob_confidence).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, logprobs: { content: [{ logprob: -0.1 }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    }));
    const withLogprobsRes = await openaiClient.complete('hello');
    expect(withLogprobsRes.confidence_source).toBe('provider_logprobs');
    expect(withLogprobsRes.logprob_confidence).toBeCloseTo(Math.exp(-0.1), 3);

    process.env.TEST_ANTHROPIC_KEY = 'ant-test-123';
    const anthropicClient = new LLMClient({
      name: 'anthropic_conf_test',
      type: 'anthropic',
      api_key_env: 'TEST_ANTHROPIC_KEY',
      default_model: 'claude-3-5-haiku-20241022',
      cheap_model: 'claude-3-5-haiku-20241022',
      reasoning_model: 'claude-3-7-sonnet-20250219',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.15,
      output_cost_per_million: 0.60,
      reasoning_cost_per_million: 0.60,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    }));
    const antRes = await anthropicClient.complete('hello');
    expect(antRes.provider_source).toBe('anthropic');
    expect(antRes.confidence_source).toBe('unavailable');
    expect(antRes.logprob_confidence).toBeUndefined();

    process.env.GEMINI_API_KEY = 'gem-test-123';
    const geminiClient = new LLMClient({
      name: 'gemini_conf_test',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-2.5-flash',
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.10,
      output_cost_per_million: 0.40,
      reasoning_cost_per_million: 0.40,
    });
    (geminiClient as any).geminiClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: 'gemini ok',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
        }),
      },
    };
    const gemRes = await geminiClient.complete('hello');
    delete process.env.GEMINI_API_KEY;
    expect(gemRes.provider_source).toBe('gemini');
    expect(gemRes.confidence_source).toBe('unavailable');
    expect(gemRes.logprob_confidence).toBeUndefined();
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
    expect(res.provider_source).toBe('mock_simulator');
  });
});
