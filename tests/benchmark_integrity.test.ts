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
import {
  PRICING_CATALOG_LAST_UPDATED,
  getProviderPricing,
  resolveLiveProviderProfile,
} from '../evals/suites/spending_guard.js';
import {
  BUDGET_EVAL_DATASET_VERSION,
  getBudgetEvalCanonicalCases,
  runBudgetEvalSuite,
} from '../evals/suites/budget_eval_suite.js';
import {
  TOOL_EVAL_DATASET_VERSION,
  getToolEvalCanonicalCases,
  runToolEvalSuite,
} from '../evals/suites/tool_eval_suite.js';
import {
  BENCHMARK_QUALITY_FLOORS,
  DATASET_HASH_ALGORITHM,
  PROJECT_ACCEPTANCE_TARGETS,
  STATISTICAL_AND_VALIDITY_FLOORS,
  assertValidBenchmarkResult,
  canonicalizeJson,
  computeDatasetHash,
  validateBenchmarkResult,
} from '../evals/suites/benchmark_validator.js';
import { UnitTestLLMDouble } from './helpers/test_llm_double.js';

function makeValidLiveBudgetResult(overrides: Record<string, any> = {}) {
  const canonicalCases = getBudgetEvalCanonicalCases('held_out', 5);
  const pricing = getProviderPricing('gemini', 'gemini-2.5-flash');
  return {
    suite_name: 'AERA/CoBa Thinking Budget Comparative Benchmark (HELD_OUT)',
    source: 'live_provider',
    benchmark_type: 'comparative_benchmark_identical_samples',
    split: 'held_out',
    dataset_version: BUDGET_EVAL_DATASET_VERSION,
    dataset_hash: computeDatasetHash(canonicalCases),
    dataset_hash_algorithm: DATASET_HASH_ALGORITHM,
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
      total_queries: canonicalCases.length,
      valid_samples: canonicalCases.length,
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
      cost_estimation_status: 'estimated_only_not_provider_billed',
      provider_billed_cost_reported: false,
      usage_source: 'provider_reported',
      currency: 'USD',
      pricing_model: pricing.model,
      pricing_source: pricing.pricing_source,
      pricing_last_updated: pricing.pricing_last_updated,
      input_cost_per_million: pricing.input,
      output_cost_per_million: pricing.output,
      reasoning_cost_per_million: pricing.reasoning,
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

  it('8. dataset hash integrity rejects modified, reordered, missing, and forged cases while passing unchanged canonical datasets', () => {
    // Canonical serialization is invariant to JS object property insertion order
    expect(canonicalizeJson({ b: 2, a: 1, unused: undefined })).toBe('{"a":1,"b":2}');
    expect(computeDatasetHash([{ id: '1', query: 'abc' }])).toBe(
      computeDatasetHash([{ query: 'abc', id: '1', extra: undefined }])
    );

    // Unchanged budget held-out (limit=5) passes
    const valid = makeValidLiveBudgetResult();
    expect(validateBenchmarkResult(valid)).toEqual({ valid: true, errors: [] });

    const baseCases = getBudgetEvalCanonicalCases('held_out', 5);

    // Modified case query / answer rejected against canonical dataset
    const modifiedCases = baseCases.map((c, idx) =>
      idx === 0 ? { ...c, query: `${c.query} [tampered]` } : c
    );
    const modifiedRes = makeValidLiveBudgetResult({ dataset_hash: computeDatasetHash(modifiedCases) });
    const modifiedValidation = validateBenchmarkResult(modifiedRes);
    expect(modifiedValidation.valid).toBe(false);
    expect(modifiedValidation.errors.join(' ')).toMatch(/Dataset hash mismatch/);

    // Reordered cases rejected (array element order is preserved in canonical hash)
    const reorderedCases = [baseCases[1], baseCases[0], ...baseCases.slice(2)];
    const reorderedRes = makeValidLiveBudgetResult({ dataset_hash: computeDatasetHash(reorderedCases) });
    const reorderedValidation = validateBenchmarkResult(reorderedRes);
    expect(reorderedValidation.valid).toBe(false);
    expect(reorderedValidation.errors.join(' ')).toMatch(/Dataset hash mismatch/);

    // Missing / deleted case rejected (even if limit_per_category claims full slice)
    const missingCases = baseCases.slice(0, -1);
    const missingRes = makeValidLiveBudgetResult({ dataset_hash: computeDatasetHash(missingCases) });
    const missingValidation = validateBenchmarkResult(missingRes);
    expect(missingValidation.valid).toBe(false);
    expect(missingValidation.errors.join(' ')).toMatch(/Dataset hash mismatch/);

    // Forged arbitrary hash & unknown dataset_version both rejected
    const forgedRes = makeValidLiveBudgetResult({ dataset_hash: computeDatasetHash(['sample']) });
    expect(validateBenchmarkResult(forgedRes).valid).toBe(false);

    const unknownVerRes = makeValidLiveBudgetResult({ dataset_version: 'ael-budget-forged-v99' });
    const unknownVerValidation = validateBenchmarkResult(unknownVerRes);
    expect(unknownVerValidation.valid).toBe(false);
    expect(unknownVerValidation.errors.join(' ')).toMatch(/Unknown dataset_version/);

    // Tool-DC canonical dataset: unchanged passes, reordered/modified/missing rejected
    const toolCases = getToolEvalCanonicalCases(5);
    const toolPricing = getProviderPricing('gemini', 'gemini-2.5-flash');
    const validTool = {
      suite_name: 'Tool-DC Verification & Safety Suite',
      source: 'live_provider',
      provider: 'gemini',
      provider_source: 'gemini',
      model: 'gemini-2.5-flash',
      credential_status: 'live_credentials_present',
      split: 'tool_selection_held_out',
      dataset_version: TOOL_EVAL_DATASET_VERSION,
      dataset_hash: computeDatasetHash(toolCases),
      dataset_hash_algorithm: DATASET_HASH_ALGORITHM,
      timestamp: '2026-11-15T10:00:00.000Z',
      live_api_credentials_present: true,
      model_config: {
        default_model: 'gemini-2.5-flash',
        cheap_model: 'gemini-2.5-flash-lite',
        reasoning_model: 'gemini-2.5-pro',
        supports_reasoning_effort: true,
        supports_logprobs: false,
      },
      sample_size: {
        selection_cases: 5,
        dry_run_catch_cases: 3,
        total_cases: 8,
        valid_samples: 8,
        limit_per_category: 5,
        full_selection_cases: 10,
      },
      token_usage: {
        ael_input_tokens: 500,
        ael_output_tokens: 150,
        ael_reasoning_tokens: 0,
        ael_total_tokens: 650,
        baseline_schema_tokens: 2400,
        usage_source: 'provider_reported',
      },
      verifier_results: {
        total_verifications: 8,
        passed: 8,
        failed: 0,
        errored: 0,
        methods: ['tool_name_exact_match', 'dry_run_sandbox_catch'],
      },
      accuracy_metrics: {
        selection_correct: 5,
        selection_total: 5,
        selection_accuracy: 1.0,
        dry_run_catches: 3,
        dry_run_catches_total: 3,
        quality_floor: 0.9,
      },
      cost_methodology: {
        billing_basis: 'estimated_from_provider_usage_and_profile_rates',
        cost_estimation_status: 'estimated_only_not_provider_billed',
        provider_billed_cost_reported: false,
        usage_source: 'provider_reported',
        currency: 'USD',
        pricing_model: toolPricing.model,
        pricing_source: toolPricing.pricing_source,
        pricing_last_updated: toolPricing.pricing_last_updated,
        input_cost_per_million: toolPricing.input,
        output_cost_per_million: toolPricing.output,
        reasoning_cost_per_million: toolPricing.reasoning,
        verification_cost_excluded_from_product_savings: true,
      },
      savings_claims_valid: true,
      acceptance_status: 'PASS',
      selection_cases_total: 5,
    };
    expect(validateBenchmarkResult(validTool)).toEqual({ valid: true, errors: [] });

    const reorderedTool = {
      ...validTool,
      dataset_hash: computeDatasetHash({
        selection_cases: [...toolCases.selection_cases].reverse(),
        catch_scenarios: toolCases.catch_scenarios,
      }),
    };
    expect(validateBenchmarkResult(reorderedTool).valid).toBe(false);

    // Caller-supplied datasetCases check catches tampering too
    expect(
      validateBenchmarkResult(valid, { datasetCases: missingCases }).errors.join(' ')
    ).toMatch(/Dataset hash mismatch/);
  });

  it('9. provider pricing integrity records provenance, distinguishes estimated vs billed cost, and rejects unknown models', () => {
    const geminiPrice = getProviderPricing('gemini', 'gemini-2.5-flash');
    expect(geminiPrice.model).toBe('gemini-2.5-flash');
    expect(geminiPrice.pricing_source).toContain('ai.google.dev');
    expect(geminiPrice.pricing_last_updated).toBe(PRICING_CATALOG_LAST_UPDATED);
    expect(geminiPrice.is_estimated_rate_card).toBe(true);

    const openaiPrice = getProviderPricing('openai', 'gpt-4o-mini');
    expect(openaiPrice.model).toBe('gpt-4o-mini');
    expect(openaiPrice.pricing_source).toContain('openai.com');

    const anthropicPrice = getProviderPricing('anthropic', 'claude-3-5-haiku-20241022');
    expect(anthropicPrice.model).toBe('claude-3-5-haiku-20241022');
    expect(anthropicPrice.pricing_source).toContain('anthropic.com');

    // Unknown or uncatalogued models MUST be rejected instead of falling back to an unrelated rate
    expect(() => getProviderPricing('gemini', 'gemini-unknown-experimental-99')).toThrow(/AEL Pricing Error/);
    expect(() => getProviderPricing('openai', 'gpt-99-imaginary')).toThrow(/AEL Pricing Error/);
    expect(() => getProviderPricing('anthropic', 'claude-unknown-sonnet')).toThrow(/AEL Pricing Error/);

    // Reject estimated cost falsely claiming to be provider-billed
    const mislabeledBilled = makeValidLiveBudgetResult({
      cost_methodology: {
        ...makeValidLiveBudgetResult().cost_methodology,
        provider_billed_cost_reported: true,
      },
    });
    expect(validateBenchmarkResult(mislabeledBilled).valid).toBe(false);

    // Reject mismatched pricing_model or missing pricing_source/date
    const wrongPricingModel = makeValidLiveBudgetResult({
      cost_methodology: {
        ...makeValidLiveBudgetResult().cost_methodology,
        pricing_model: 'gemini-2.5-flash-lite',
      },
    });
    expect(validateBenchmarkResult(wrongPricingModel).valid).toBe(false);

    const badPricingDate = makeValidLiveBudgetResult({
      cost_methodology: {
        ...makeValidLiveBudgetResult().cost_methodology,
        pricing_last_updated: 'unknown',
      },
    });
    expect(validateBenchmarkResult(badPricingDate).valid).toBe(false);
  });

  it('10. benchmark thresholds cleanly separate validity guardrails from project acceptance targets', () => {
    expect(STATISTICAL_AND_VALIDITY_FLOORS).toEqual({
      budget_min_baseline_accuracy: 0.50,
      budget_min_ael_accuracy: 0.50,
    });
    expect(PROJECT_ACCEPTANCE_TARGETS).toEqual({
      tool_selection_accuracy: 0.90,
      tool_dry_run_catches: 3,
      budget_min_token_reduction_pct: 50.0,
      budget_max_accuracy_drop_pp: 2.0,
      budget_max_p95_overhead_ms: 500,
    });
    expect(BENCHMARK_QUALITY_FLOORS).toEqual({
      ...STATISTICAL_AND_VALIDITY_FLOORS,
      ...PROJECT_ACCEPTANCE_TARGETS,
    });
  });
});
