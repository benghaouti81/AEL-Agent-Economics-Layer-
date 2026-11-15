/**
 * Unit Tests: LLM Client & Provider Adapters
 * Verifies live provider cost math, credential enforcement, strict response/usage validation,
 * reasoning effort wiring, and retry handling with zero mock fallback.
 * @license Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  LLMClient,
  isGeminiRateLimitError,
  parseGeminiRetryInfoMs,
} from '../src/llm/client.js';

describe('LLMClient Adapter Layer', () => {
  const originalOpenAIKey = process.env.TEST_OPENAI_KEY;
  const originalAnthropicKey = process.env.TEST_ANTHROPIC_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalOpenAIKey === undefined) delete process.env.TEST_OPENAI_KEY;
    else process.env.TEST_OPENAI_KEY = originalOpenAIKey;
    if (originalAnthropicKey === undefined) delete process.env.TEST_ANTHROPIC_KEY;
    else process.env.TEST_ANTHROPIC_KEY = originalAnthropicKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  });

  it('calculates dollar costs accurately across token types and pricing tables', () => {
    const client = new LLMClient({
      name: 'gemini_pricing_test',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-2.5-flash',
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 1.0,
      output_cost_per_million: 2.0,
      reasoning_cost_per_million: 3.0,
    });

    const cost = client.calculateCost(1_000_000, 1_000_000, 1_000_000);
    expect(cost).toBe(6.0);
  });

  it('rejects unsupported runtime provider types (e.g. legacy mock) without fallback', async () => {
    const client = new LLMClient({
      name: 'legacy_mock',
      type: 'mock' as any,
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

    await expect(client.complete('hello')).rejects.toThrow(/Unsupported provider type/);
  });

  it('throws on missing credentials or adapter failure without silent mock fallback', async () => {
    delete process.env.TEST_OPENAI_KEY;
    delete process.env.TEST_ANTHROPIC_KEY;
    delete process.env.GEMINI_API_KEY;

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

    const geminiMissingKey = new LLMClient({
      name: 'gemini_no_key',
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
    await expect(geminiMissingKey.complete('hello')).rejects.toThrow(/Missing or invalid Gemini API key/);

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

  it('fails explicitly on invalid provider payloads or missing token usage without estimating or zeroing counts', async () => {
    process.env.TEST_OPENAI_KEY = 'sk-test-123';
    const openaiClient = new LLMClient({
      name: 'openai_strict',
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [] }),
    }));
    await expect(openaiClient.complete('hello')).rejects.toThrow(/missing choices/i);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }));
    await expect(openaiClient.complete('hello')).rejects.toThrow(/missing usage metadata/i);

    process.env.TEST_ANTHROPIC_KEY = 'ant-test-123';
    const anthropicClient = new LLMClient({
      name: 'anthropic_strict',
      type: 'anthropic',
      api_key_env: 'TEST_ANTHROPIC_KEY',
      default_model: 'claude-3-5-haiku-20241022',
      cheap_model: 'claude-3-5-haiku-20241022',
      reasoning_model: 'claude-3-7-sonnet-20250219',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.80,
      output_cost_per_million: 4.00,
      reasoning_cost_per_million: 4.00,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10 } }),
    }));
    await expect(anthropicClient.complete('hello')).rejects.toThrow(/output_tokens/i);

    process.env.GEMINI_API_KEY = 'gem-test-123';
    const geminiClient = new LLMClient({
      name: 'gemini_strict',
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
        }),
      },
    };
    await expect(geminiClient.complete('hello')).rejects.toThrow(/missing usageMetadata/i);
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
    expect(noLogprobsRes.usage_source).toBe('provider_reported');
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
    expect(antRes.usage_source).toBe('provider_reported');
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
    expect(gemRes.provider_source).toBe('gemini');
    expect(gemRes.usage_source).toBe('provider_reported');
    expect(gemRes.confidence_source).toBe('unavailable');
    expect(gemRes.logprob_confidence).toBeUndefined();
  });

  it('warns and degrades gracefully when reasoning effort is unsupported by provider profile', async () => {
    process.env.TEST_OPENAI_KEY = 'sk-test-123';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'Degraded answer' } }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new LLMClient({
      name: 'unsupported_provider',
      type: 'openai',
      api_key_env: 'TEST_OPENAI_KEY',
      default_model: 'gpt-4o-mini',
      cheap_model: 'gpt-4o-mini',
      reasoning_model: 'gpt-4o-mini',
      supports_reasoning_effort: false,
      supports_logprobs: false,
      input_cost_per_million: 0.15,
      output_cost_per_million: 0.60,
      reasoning_cost_per_million: 0.60,
    });

    const res = await client.complete('Query with unsupported knob', { reasoning_effort: 'high' });
    expect(res).toBeDefined();
    expect(res.total_tokens).toBe(20);
    expect(res.provider_source).toBe('openai');
    expect(res.usage_source).toBe('provider_reported');
    expect(warnSpy).toHaveBeenCalled();

    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sentBody.reasoning_effort).toBeUndefined();
  });

  it('wires reasoning_effort to Gemini thinkingConfig.thinkingBudget (Gemini 2.5) and thinkingLevel per provider profile (P0-17)', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-123';

    const geminiBudgetClient = new LLMClient({
      name: 'gemini_25_budget',
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
    const budgetSpy = vi.fn().mockResolvedValue({
      text: 'ok',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    (geminiBudgetClient as any).geminiClient = { models: { generateContent: budgetSpy } };

    await geminiBudgetClient.complete('q0', { reasoning_effort: 'none' });
    await geminiBudgetClient.complete('q1', { reasoning_effort: 'low' });
    await geminiBudgetClient.complete('q2', { reasoning_effort: 'medium' });
    await geminiBudgetClient.complete('q3', { reasoning_effort: 'high' });

    expect(budgetSpy.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(budgetSpy.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingBudget: 512 });
    expect(budgetSpy.mock.calls[2][0].config.thinkingConfig).toEqual({ thinkingBudget: 2048 });
    expect(budgetSpy.mock.calls[3][0].config.thinkingConfig).toEqual({ thinkingBudget: 8192 });

    expect(budgetSpy.mock.calls[0][0].config.thinkingConfig.thinkingBudget)
      .toBeLessThan(budgetSpy.mock.calls[1][0].config.thinkingConfig.thinkingBudget);
    expect(budgetSpy.mock.calls[1][0].config.thinkingConfig.thinkingBudget)
      .toBeLessThan(budgetSpy.mock.calls[2][0].config.thinkingConfig.thinkingBudget);
    expect(budgetSpy.mock.calls[2][0].config.thinkingConfig.thinkingBudget)
      .toBeLessThan(budgetSpy.mock.calls[3][0].config.thinkingConfig.thinkingBudget);

    const customBudgetClient = new LLMClient({
      name: 'gemini_custom_budget',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-2.5-flash',
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      gemini_thinking_budgets: { low: 256, high: 4096 },
      input_cost_per_million: 0.10,
      output_cost_per_million: 0.40,
      reasoning_cost_per_million: 0.40,
    });
    const customSpy = vi.fn().mockResolvedValue({
      text: 'ok',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    (customBudgetClient as any).geminiClient = { models: { generateContent: customSpy } };

    await customBudgetClient.complete('q_custom_low', { reasoning_effort: 'low' });
    await customBudgetClient.complete('q_custom_high', { reasoning_effort: 'high' });
    expect(customSpy.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingBudget: 256 });
    expect(customSpy.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingBudget: 4096 });

    const geminiLevelClient = new LLMClient({
      name: 'gemini_level',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-3-flash-preview',
      cheap_model: 'gemini-3-flash-preview',
      reasoning_model: 'gemini-3-pro-preview',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      gemini_thinking_mode: 'level',
      input_cost_per_million: 0.10,
      output_cost_per_million: 0.40,
      reasoning_cost_per_million: 0.40,
    });
    const levelSpy = vi.fn().mockResolvedValue({
      text: 'ok',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    (geminiLevelClient as any).geminiClient = { models: { generateContent: levelSpy } };

    await geminiLevelClient.complete('l0', { reasoning_effort: 'none' });
    await geminiLevelClient.complete('l1', { reasoning_effort: 'low' });
    await geminiLevelClient.complete('l2', { reasoning_effort: 'medium' });
    await geminiLevelClient.complete('l3', { reasoning_effort: 'high' });

    expect(levelSpy.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(levelSpy.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(levelSpy.mock.calls[2][0].config.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(levelSpy.mock.calls[3][0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });

    const unsupportedGemini = new LLMClient({
      name: 'gemini_no_reasoning',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-2.0-flash',
      cheap_model: 'gemini-2.0-flash',
      reasoning_model: 'gemini-2.0-flash',
      supports_reasoning_effort: false,
      supports_logprobs: false,
      input_cost_per_million: 0.10,
      output_cost_per_million: 0.40,
      reasoning_cost_per_million: 0.40,
    });
    const noEffortSpy = vi.fn().mockResolvedValue({
      text: 'ok',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    (unsupportedGemini as any).geminiClient = { models: { generateContent: noEffortSpy } };

    await unsupportedGemini.complete('q_unsupported', { reasoning_effort: 'high' });
    expect(noEffortSpy.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('reads Gemini usageMetadata.thoughtsTokenCount with fallback and includes reasoning tokens in total_tokens and cost_usd (P0-18)', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-123';
    const client = new LLMClient({
      name: 'gemini_thoughts_cost',
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

    const generateSpy = vi.fn().mockResolvedValueOnce({
      text: 'final answer',
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 250,
        thoughtsTokenCount: 4000,
        totalTokenCount: 5250,
      },
    });
    (client as any).geminiClient = { models: { generateContent: generateSpy } };

    const withThoughts = await client.complete('Solve hard problem', { reasoning_effort: 'high' });
    expect(withThoughts.input_tokens).toBe(1000);
    expect(withThoughts.output_tokens).toBe(250);
    expect(withThoughts.reasoning_tokens).toBe(4000);
    expect(withThoughts.total_tokens).toBe(5250);

    const expectedCostWithoutThoughts = client.calculateCost(1000, 250, 0);
    const expectedCostWithThoughts = client.calculateCost(1000, 250, 4000);
    expect(expectedCostWithThoughts).toBeGreaterThan(expectedCostWithoutThoughts);
    expect(withThoughts.cost_usd).toBe(expectedCostWithThoughts);
    expect(withThoughts.cost_usd).toBeCloseTo(0.0018, 6);

    generateSpy.mockResolvedValueOnce({
      text: 'fallback answer',
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 100,
        reasoningTokenCount: 300,
      },
    });
    const withLegacyField = await client.complete('Fallback query', { reasoning_effort: 'medium' });
    expect(withLegacyField.reasoning_tokens).toBe(300);
    expect(withLegacyField.total_tokens).toBe(900);
    expect(withLegacyField.cost_usd).toBe(client.calculateCost(500, 100, 300));

    generateSpy.mockResolvedValueOnce({
      text: 'plain answer',
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 50,
      },
    });
    const withoutThoughts = await geminiClientOrFallback(client);
    expect(withoutThoughts.reasoning_tokens).toBe(0);
    expect(withoutThoughts.total_tokens).toBe(250);
    expect(withoutThoughts.cost_usd).toBe(client.calculateCost(200, 50, 0));
  });

  it('parses RetryInfo and retries Gemini 429 RESOURCE_EXHAUSTED with exponential backoff up to 5 attempts, failing cleanly on exhaustion (P0-21)', async () => {
    expect(parseGeminiRetryInfoMs({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] })).toBe(12000);
    expect(parseGeminiRetryInfoMs(new Error('got status: 429 {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"4.5s"}]}}'))).toBe(4500);
    expect(parseGeminiRetryInfoMs(new Error('Quota exceeded. Please retry in 3.2s.'))).toBe(3200);
    expect(isGeminiRateLimitError({ status: 429 })).toBe(true);
    expect(isGeminiRateLimitError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isGeminiRateLimitError(new Error('400 INVALID_ARGUMENT'))).toBe(false);

    vi.useFakeTimers();
    process.env.GEMINI_API_KEY = 'gem-test-123';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const client = new LLMClient({
        name: 'gemini_retry_test',
        type: 'gemini',
        api_key_env: 'GEMINI_API_KEY',
        default_model: 'gemini-2.5-flash-lite',
        cheap_model: 'gemini-2.5-flash-lite',
        reasoning_model: 'gemini-2.5-pro',
        supports_reasoning_effort: true,
        supports_logprobs: false,
        input_cost_per_million: 0.10,
        output_cost_per_million: 0.40,
        reasoning_cost_per_million: 0.40,
      });

      const recoverSpy = vi
        .fn()
        .mockRejectedValueOnce(new Error('429 RESOURCE_EXHAUSTED {"details":[{"retryDelay":"3s"}]}'))
        .mockRejectedValueOnce(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))
        .mockResolvedValueOnce({
          text: 'recovered after backoff',
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
        });
      (client as any).geminiClient = { models: { generateContent: recoverSpy } };

      const recoverPromise = client.complete('retry test');
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(2000);
      const recovered = await recoverPromise;
      expect(recovered.text).toBe('recovered after backoff');
      expect(recoverSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0][0]).toContain('RetryInfo=3000ms');
      expect(warnSpy.mock.calls[1][0]).toContain('2000ms');

      warnSpy.mockClear();

      const exhaustSpy = vi.fn().mockRejectedValue(
        Object.assign(new Error('429 RESOURCE_EXHAUSTED quota still exhausted'), { status: 429 })
      );
      (client as any).geminiClient = { models: { generateContent: exhaustSpy } };

      const exhaustPromise = client.complete('exhaust test').catch(err => err);
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
      const exhaustErr = await exhaustPromise;
      expect(exhaustErr).toBeInstanceOf(Error);
      expect(exhaustErr.message).toMatch(/exhausted after 5 attempts/i);
      expect(exhaustSpy).toHaveBeenCalledTimes(5);
      expect(warnSpy).toHaveBeenCalledTimes(4);

      const nonRetrySpy = vi.fn().mockRejectedValue(Object.assign(new Error('400 Bad Request'), { status: 400 }));
      (client as any).geminiClient = { models: { generateContent: nonRetrySpy } };
      await expect(client.complete('non-retry test')).rejects.toThrow(/400 Bad Request/);
      expect(nonRetrySpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // NOTE: Tests below exercise adapter request construction and usage parsing against realistic
  // provider response fixtures / stubs — they verify adapter logic ONLY and are NOT live API checks.
  it('selects thinkingLevel for Gemini 4 (lowest=LOW, never MINIMAL) and Gemini 3 vs thinkingBudget for Gemini 2.5 Pro/Flash via realistic fixtures', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-adapter-fixtures';

    // 1. Gemini 4 (gemini-4-hydrogen, plus models/ prefix): auto-selects thinkingLevel; 'none' maps to LOW
    const gemini4Client = new LLMClient({
      name: 'gemini_4_fixture',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-4-hydrogen',
      cheap_model: 'gemini-4-hydrogen',
      reasoning_model: 'gemini-4-argon',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.5,
      output_cost_per_million: 3.0,
      reasoning_cost_per_million: 3.0,
    });
    const g4Spy = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: '42' }] } }],
      usageMetadata: {
        promptTokenCount: 18,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 120,
        totalTokenCount: 142,
      },
    });
    (gemini4Client as any).geminiClient = { models: { generateContent: g4Spy } };

    await gemini4Client.complete('q4_none', { reasoning_effort: 'none' });
    await gemini4Client.complete('q4_low', { reasoning_effort: 'low', model: 'models/gemini-4-hydrogen' });
    await gemini4Client.complete('q4_medium', { reasoning_effort: 'medium' });
    await gemini4Client.complete('q4_high', { reasoning_effort: 'high', model: 'gemini-4-argon' });

    expect(g4Spy.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(g4Spy.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(g4Spy.mock.calls[2][0].config.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(g4Spy.mock.calls[3][0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
    for (const call of g4Spy.mock.calls) {
      expect(call[0].config.thinkingConfig.thinkingBudget).toBeUndefined();
    }

    // 2. Gemini 3 (gemini-3-flash-preview) without explicit gemini_thinking_mode still selects thinkingLevel
    const gemini3Client = new LLMClient({
      name: 'gemini_3_fixture',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-3-flash-preview',
      cheap_model: 'gemini-3-flash-preview',
      reasoning_model: 'gemini-3-pro-preview',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.5,
      output_cost_per_million: 3.0,
      reasoning_cost_per_million: 3.0,
    });
    const g3Spy = vi.fn().mockResolvedValue({
      text: 'ok',
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 8, totalTokenCount: 23 },
    });
    (gemini3Client as any).geminiClient = { models: { generateContent: g3Spy } };

    await gemini3Client.complete('q3_none', { reasoning_effort: 'none' });
    await gemini3Client.complete('q3_high', { reasoning_effort: 'high' });
    expect(g3Spy.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(g3Spy.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });

    // 3. Gemini 2.5 Pro sets minimum 128 on 'none' while Gemini 2.5 Flash sets 0
    const gemini25ProClient = new LLMClient({
      name: 'gemini_25_pro_fixture',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-2.5-pro',
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 1.25,
      output_cost_per_million: 10.0,
      reasoning_cost_per_million: 10.0,
    });
    const g25Spy = vi.fn().mockResolvedValue({
      text: 'ok',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 10, totalTokenCount: 35 },
    });
    (gemini25ProClient as any).geminiClient = { models: { generateContent: g25Spy } };
    await gemini25ProClient.complete('q25_pro_none', { reasoning_effort: 'none' });
    expect(g25Spy.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingBudget: 128 });
  });

  it('prevents reasoning token double-counting on both inclusive and disjoint response fixtures and rejects invalid thoughtsTokenCount', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-usage-fixtures';
    const geminiClient = new LLMClient({
      name: 'gemini_counting_fixture',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'gemini-2.5-flash',
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 1.0,
      output_cost_per_million: 2.0,
      reasoning_cost_per_million: 2.0,
    });

    const gemSpy = vi
      .fn()
      // Disjoint: total = 100 + 40 + 180 = 320
      .mockResolvedValueOnce({
        text: 'disjoint response',
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 180,
          totalTokenCount: 320,
        },
      })
      // Inclusive candidatesTokenCount (total === prompt + candidates while thoughts <= candidates): total = 100 + 220 = 320
      .mockResolvedValueOnce({
        text: 'inclusive response',
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 220,
          thoughtsTokenCount: 180,
          totalTokenCount: 320,
        },
      })
      // Corrupted negative thoughtsTokenCount must fail explicitly rather than zeroing
      .mockResolvedValueOnce({
        text: 'bad usage',
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 40,
          thoughtsTokenCount: -5,
        },
      });
    (geminiClient as any).geminiClient = { models: { generateContent: gemSpy } };

    const disjointRes = await geminiClient.complete('disjoint');
    expect(disjointRes.input_tokens).toBe(100);
    expect(disjointRes.output_tokens).toBe(40);
    expect(disjointRes.reasoning_tokens).toBe(180);
    expect(disjointRes.total_tokens).toBe(320);
    expect(disjointRes.cost_usd).toBe(geminiClient.calculateCost(100, 40, 180));

    const inclusiveRes = await geminiClient.complete('inclusive');
    expect(inclusiveRes.input_tokens).toBe(100);
    expect(inclusiveRes.output_tokens).toBe(40);
    expect(inclusiveRes.reasoning_tokens).toBe(180);
    expect(inclusiveRes.total_tokens).toBe(320);
    expect(inclusiveRes.cost_usd).toBe(geminiClient.calculateCost(100, 40, 180));

    await expect(geminiClient.complete('invalid-thoughts')).rejects.toThrow(/thoughtsTokenCount/);

    // OpenAI inclusive completion_tokens fixture (standard Chat Completions API: completion_tokens includes reasoning_tokens)
    process.env.TEST_OPENAI_KEY = 'sk-test-usage-fixtures';
    const openaiClient = new LLMClient({
      name: 'openai_counting_fixture',
      type: 'openai',
      api_key_env: 'TEST_OPENAI_KEY',
      default_model: 'gpt-4o-mini',
      cheap_model: 'gpt-4o-mini',
      reasoning_model: 'o3-mini',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 1.0,
      output_cost_per_million: 2.0,
      reasoning_cost_per_million: 2.0,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: 'o3-mini',
        choices: [{ message: { content: 'inclusive openai response' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 220,
          total_tokens: 320,
          completion_tokens_details: { reasoning_tokens: 180 },
        },
      }),
    }));

    const oaiInclusive = await openaiClient.complete('o3 test', { reasoning_effort: 'high' });
    expect(oaiInclusive.input_tokens).toBe(100);
    expect(oaiInclusive.output_tokens).toBe(40);
    expect(oaiInclusive.reasoning_tokens).toBe(180);
    expect(oaiInclusive.total_tokens).toBe(320);
    expect(oaiInclusive.cost_usd).toBe(openaiClient.calculateCost(100, 40, 180));
  });
});

async function geminiClientOrFallback(client: LLMClient) {
  return await client.complete('Simple query', { reasoning_effort: 'none' });
}
