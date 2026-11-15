/**
 * Regression Suite: Benchmark Integrity & Anti-Mock Safeguards
 * Proves that:
 * 1. Missing credentials cannot trigger a mock fallback.
 * 2. Mock results cannot pass benchmark acceptance.
 * 3. Unit tests cannot generate accepted performance evidence.
 * 4. Invalid provider responses fail explicitly.
 * 5. Live results preserve actual provider usage metadata.
 * 6. Missing token usage cannot silently become zero or estimated via length/4.
 * 7. Failed evaluations cannot produce misleading savings claims.
 * @license Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { AelConfigSchema } from '../src/config/ael_config.js';
import { LLMClient } from '../src/llm/client.js';
import { resolveLiveProviderProfile } from '../evals/suites/spending_guard.js';
import { runBudgetEvalSuite } from '../evals/suites/budget_eval_suite.js';
import { runToolEvalSuite } from '../evals/suites/tool_eval_suite.js';
import {
  assertValidBenchmarkResult,
  computeDatasetHash,
  validateBenchmarkResult,
} from '../evals/suites/benchmark_validator.js';
import { UnitTestLLMDouble } from './helpers/test_llm_double.js';

function makeValidLiveBudgetResult(overrides: Record<string, any> = {}) {
  return {
    suite_name: 'AERA/CoBa Thinking Budget Comparative Benchmark (HELD_OUT)',
    source: 'live_provider',
    benchmark_type: 'comparative_benchmark_identical_samples',
    split: 'held_out',
    dataset_version: 'ael-budget-v2.0-200q',
    dataset_hash: computeDatasetHash(['sample']),
    timestamp: '2026-11-15T10:00:00.000Z',
    live_api_credentials_present: true,
    provider: 'gemini',
    provider_source: 'gemini',
    model: 'gemini-2.5-flash',
    credential_status: 'live_credentials_present',
    model_config: {
      default_model: 'gemini-2.5-flash',
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
    },
    sample_size: {
      total_queries: 20,
      valid_samples: 20,
      per_category: { factual: 5, math: 5, code: 5, extraction: 5 },
      limit_per_category: 5,
      full_dataset_queries: 200,
    },
    token_usage: {
      baseline_input_tokens: 1000,
      baseline_output_tokens: 800,
      baseline_reasoning_tokens: 4000,
      baseline_total_tokens: 5800,
      ael_input_tokens: 1000,
      ael_output_tokens: 800,
      ael_reasoning_tokens: 200,
      ael_total_tokens: 2000,
      verifier_total_tokens: 100,
      usage_source: 'provider_reported',
    },
    verifier_results: {
      total_verifications: 40,
      passed: 38,
      failed: 2,
      errored: 0,
      methods: ['judge_verdict', 'numeric_match', 'code_execution', 'json_field_match'],
    },
    accuracy_metrics: {
      baseline_correct: 19,
      baseline_total: 20,
      baseline_accuracy: 0.95,
      ael_correct: 19,
      ael_total: 20,
      ael_accuracy: 0.95,
      accuracy_delta_pp: 0,
      accuracy_drop_pp: 0,
      quality_floor: 0.5,
    },
    cost_methodology: {
      billing_basis: 'estimated_from_provider_usage_and_profile_rates',
      provider_billed_cost_reported: false,
      usage_source: 'provider_reported',
      currency: 'USD',
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
      verification_cost_excluded_from_product_savings: true,
    },
    savings_claims_valid: true,
    acceptance_status: 'PASS',
    overall_baseline_tokens: 5800,
    overall_actual_tokens: 2000,
    overall_token_reduction_pct: 65.5,
    overall_net_savings_usd: 0.00152,
    accuracy_drop_pp: 0,
    overall_p95_overhead_ms: 42,
    ...overrides,
  };
}

describe('Benchmark Integrity & Anti-Mock Regression Suite', () => {
  const origGemini = process.env.GEMINI_API_KEY;
  const origOpenAI = process.env.OPENAI_API_KEY;
  const origAnthropic = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGemini;
    if (origOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origOpenAI;
    if (origAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origAnthropic;
  });

  it('1. missing or placeholder credentials cannot trigger a mock fallback', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => resolveLiveProviderProfile()).toThrow(/Missing live provider credentials/);

    process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY';
    process.env.OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY';
    process.env.ANTHROPIC_API_KEY = 'REPLACE_ME';
    expect(() => resolveLiveProviderProfile()).toThrow(/Missing live provider credentials/);

    expect(() =>
      AelConfigSchema.parse({
        provider: {
          name: 'mock',
          type: 'mock',
          api_key_env: 'KEY',
          default_model: 'mock',
          cheap_model: 'mock',
          reasoning_model: 'mock',
        },
      })
    ).toThrow();

    const store = new DecisionLogStore(':memory:');
    await expect(runBudgetEvalSuite(store, 'tuning')).rejects.toThrow(/Missing live provider credentials/);
    await expect(runToolEvalSuite(store)).rejects.toThrow(/Missing live provider credentials/);
    store.close();
  });

  it('2. mock results cannot pass benchmark acceptance', () => {
    const mockSource = makeValidLiveBudgetResult({ source: 'mock_simulator' });
    const mockRes = validateBenchmarkResult(mockSource);
    expect(mockRes.valid).toBe(false);
    expect(mockRes.errors.join(' ')).toMatch(/mock_simulator|live_provider/i);
    expect(() => assertValidBenchmarkResult(mockSource)).toThrow(/REJECTED/);

    const mockProviderSource = makeValidLiveBudgetResult({ provider_source: 'mock_simulator' });
    expect(validateBenchmarkResult(mockProviderSource).valid).toBe(false);

    const mockModel = makeValidLiveBudgetResult({ model: 'mock' });
    expect(validateBenchmarkResult(mockModel).valid).toBe(false);
  });

  it('3. unit tests cannot generate accepted performance evidence', async () => {
    const unitSourceResult = makeValidLiveBudgetResult({
      source: 'unit_test',
      provider_source: 'unit_test',
      token_usage: {
        ...makeValidLiveBudgetResult().token_usage,
        usage_source: 'unit_test',
      },
    });
    const validation = validateBenchmarkResult(unitSourceResult);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/unit_test|live_provider/i);
    expect(() => assertValidBenchmarkResult(unitSourceResult)).toThrow(/REJECTED/);

    // Even if credentials env var is set, a UnitTestLLMDouble injected into LLMClient.complete MUST be rejected by eval suites
    process.env.OPENAI_API_KEY = 'sk-test-guard';
    vi.spyOn(LLMClient.prototype, 'complete').mockImplementation(async function (this: LLMClient, prompt, options) {
      return await new UnitTestLLMDouble().complete(prompt, options);
    });

    const store = new DecisionLogStore(':memory:');
    await expect(runBudgetEvalSuite(store, 'tuning', { provider: 'openai' })).rejects.toThrow(
      /Benchmark Integrity Error/
    );
    await expect(runToolEvalSuite(store, { provider: 'openai', limit: 1 })).rejects.toThrow(
      /Benchmark Integrity Error/
    );
    store.close();
  });

  it('4. invalid provider responses fail explicitly across OpenAI, Anthropic, and Gemini', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-valid';
    const openaiClient = new LLMClient({
      name: 'openai',
      type: 'openai',
      api_key_env: 'OPENAI_API_KEY',
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
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));
    await expect(openaiClient.complete('hi')).rejects.toThrow(/malformed JSON/i);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }));
    await expect(openaiClient.complete('hi')).rejects.toThrow(/empty message\.content/i);

    process.env.ANTHROPIC_API_KEY = 'sk-ant-valid';
    const anthropicClient = new LLMClient({
      name: 'anthropic',
      type: 'anthropic',
      api_key_env: 'ANTHROPIC_API_KEY',
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
      json: async () => ({ content: [], usage: { input_tokens: 5, output_tokens: 5 } }),
    }));
    await expect(anthropicClient.complete('hi')).rejects.toThrow(/missing content blocks/i);

    process.env.GEMINI_API_KEY = 'gem-test-valid';
    const geminiClient = new LLMClient({
      name: 'gemini',
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
          candidates: [],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        }),
      },
    };
    await expect(geminiClient.complete('hi')).rejects.toThrow(/zero candidates/i);
  });

  it('5. live results preserve actual provider usage metadata and full provenance fields', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-live-provenance';
    let baselineCalls = 0;
    let aelCalls = 0;
    let verifierCalls = 0;
    let aelReasoningSum = 0;

    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const prompt: string = body?.messages?.[0]?.content || '';
      const isHigh = body?.reasoning_effort === 'high';
      const isVerifier = prompt.includes('VERIFY ANSWER CORRECTNESS');
      const isJudgeEscalation = prompt.includes('EVALUATE EVIDENCE AND RESOLVE QUERY');

      let content = 'Apollo 11 landed in 1969.';
      if (isVerifier) content = '{"correct": true}';
      else if (prompt.includes('distinct prime factors of 360')) content = '\\boxed{10}';
      else if (prompt.includes('reverseInPlace')) {
        content = '```ts\nfunction reverseInPlace<T>(arr: T[]): T[] { let l=0,r=arr.length-1; while(l<r){[arr[l],arr[r]]=[arr[r],arr[l]];l++;r--;} return arr; }\n```';
      } else if (prompt.includes('Jane Doe')) {
        content = '{"name":"Jane Doe","email":"jane.doe@acme.io","phone":"+1-555-0192"}';
      }

      const prompt_tokens = 123;
      const completion_tokens = 45;
      const reasoning_tokens = isVerifier ? 0 : isHigh ? 600 : isJudgeEscalation ? 25 : 12;

      if (isVerifier) {
        verifierCalls++;
      } else if (isHigh && !isJudgeEscalation) {
        baselineCalls++;
      } else {
        aelCalls++;
        aelReasoningSum += reasoning_tokens;
      }

      return {
        ok: true,
        json: async () => ({
          model: 'gpt-4o-mini-2024-07-18',
          choices: [{ message: { content }, logprobs: { content: [{ logprob: -0.02 }] } }],
          usage: {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens + reasoning_tokens,
            completion_tokens_details: { reasoning_tokens },
          },
        }),
      };
    }));

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const store = new DecisionLogStore(':memory:');
    try {
      const res = await runBudgetEvalSuite(store, 'tuning', { provider: 'openai', model: 'gpt-4o-mini' });
      expect(res.source).toBe('live_provider');
      expect(res.provider).toBe('openai');
      expect(res.provider_source).toBe('openai');
      expect(res.credential_status).toBe('live_credentials_present');
      expect(res.dataset_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.sample_size.valid_samples).toBe(4);
      expect(res.token_usage.usage_source).toBe('provider_reported');
      expect(baselineCalls).toBe(4);
      expect(res.token_usage.baseline_input_tokens).toBe(baselineCalls * 123);
      expect(res.token_usage.baseline_output_tokens).toBe(baselineCalls * 45);
      expect(res.token_usage.baseline_reasoning_tokens).toBe(baselineCalls * 600);
      expect(res.token_usage.ael_input_tokens).toBe(aelCalls * 123);
      expect(res.token_usage.ael_output_tokens).toBe(aelCalls * 45);
      expect(res.token_usage.ael_reasoning_tokens).toBe(aelReasoningSum);
      expect(res.token_usage.verifier_total_tokens).toBe(verifierCalls * (123 + 45));
      expect(res.verifier_results.total_verifications).toBe(8);
      expect(res.verifier_results.errored).toBe(0);
      expect(res.cost_methodology.billing_basis).toBe('estimated_from_provider_usage_and_profile_rates');
      expect(res.cost_methodology.provider_billed_cost_reported).toBe(false);
      expect(validateBenchmarkResult(res).valid).toBe(true);
    } finally {
      writeSpy.mockRestore();
      store.close();
    }
  });

  it('6. missing token usage cannot silently become zero or fall back to length estimates', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-usage';
    const openaiClient = new LLMClient({
      name: 'openai',
      type: 'openai',
      api_key_env: 'OPENAI_API_KEY',
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
      json: async () => ({
        choices: [{ message: { content: 'valid text but missing completion_tokens' } }],
        usage: { prompt_tokens: 20 },
      }),
    }));
    await expect(openaiClient.complete('hi')).rejects.toThrow(/completion_tokens/i);

    process.env.GEMINI_API_KEY = 'gem-test-usage';
    const geminiClient = new LLMClient({
      name: 'gemini',
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
          text: 'valid text but missing candidatesTokenCount',
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: Number.NaN },
        }),
      },
    };
    await expect(geminiClient.complete('hi')).rejects.toThrow(/candidatesTokenCount/i);
  });

  it('7. failed evaluations (including 0/N baseline vs 0/N AEL and verifier errors) cannot pass or emit misleading savings claims', async () => {
    // Reject 0/N on both sides in acceptance validator even if acceptance_status was falsified
    const zeroBothSides = makeValidLiveBudgetResult({
      accuracy_metrics: {
        baseline_correct: 0,
        baseline_total: 20,
        baseline_accuracy: 0,
        ael_correct: 0,
        ael_total: 20,
        ael_accuracy: 0,
        accuracy_delta_pp: 0,
        accuracy_drop_pp: 0,
        quality_floor: 0.5,
      },
      acceptance_status: 'FAIL (Accuracy below quality floor)',
      savings_claims_valid: false,
      overall_net_savings_usd: null,
      overall_token_reduction_pct: null,
    });
    const zeroValidation = validateBenchmarkResult(zeroBothSides);
    expect(zeroValidation.valid).toBe(false);
    expect(zeroValidation.errors.join(' ')).toMatch(/quality floor|zero-on-both-sides/i);

    // Reject a failed evaluation that still tries to claim savings
    const misleadingFailedClaim = makeValidLiveBudgetResult({
      acceptance_status: 'FAIL (Accuracy below quality floor)',
      savings_claims_valid: true,
      overall_net_savings_usd: 1.25,
      overall_token_reduction_pct: 75,
    });
    expect(validateBenchmarkResult(misleadingFailedClaim).valid).toBe(false);

    // End-to-end suite run where model returns wrong answers -> 0/4 accuracy on both sides MUST fail & suppress headline savings
    process.env.OPENAI_API_KEY = 'sk-test-zero-acc';
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const prompt: string = body?.messages?.[0]?.content || '';
      const isHigh = body?.reasoning_effort === 'high';
      const content = prompt.includes('VERIFY ANSWER CORRECTNESS') ? '{"correct": false}' : 'Wrong answer xyz';
      const r = isHigh ? 500 : 10;
      return {
        ok: true,
        json: async () => ({
          model: 'gpt-4o-mini',
          choices: [{ message: { content }, logprobs: { content: [{ logprob: -0.01 }] } }],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 20,
            total_tokens: 70 + r,
            completion_tokens_details: { reasoning_tokens: r },
          },
        }),
      };
    }));

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const store = new DecisionLogStore(':memory:');
    try {
      const failedRun = await runBudgetEvalSuite(store, 'tuning', { provider: 'openai' });
      expect(failedRun.acceptance_status).toBe('FAIL (Accuracy below quality floor)');
      expect(failedRun.savings_claims_valid).toBe(false);
      expect(failedRun.overall_net_savings_usd).toBeNull();
      expect(failedRun.overall_token_reduction_pct).toBeNull();
      expect(failedRun.overall_token_reduction_ratio).toMatch(/NOT_CLAIMED/);
      expect(() => assertValidBenchmarkResult(failedRun)).toThrow(/REJECTED/);
    } finally {
      writeSpy.mockRestore();
      store.close();
    }
  });
});
