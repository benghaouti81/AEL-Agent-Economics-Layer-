/**
 * AEL — Live Evaluation Spending Guard & Credential Validator
 * Prevents runaway API spend on live evaluation suites and enforces explicit live provider credentials.
 * @license Apache-2.0
 */

import { ProviderProfile } from '../../src/config/ael_config.js';
import { CallUsageRecord, isPlaceholderOrEmptyKey } from '../../src/llm/client.js';

export const MAX_LIVE_EVAL_COST_USD = 1.0;

export type LiveProviderType = 'gemini' | 'openai' | 'anthropic';

export interface ProjectedCostBreakdown {
  queryCount: number;
  callsPerQuery: number;
  projectedInputTokens: number;
  projectedOutputTokens: number;
  projectedReasoningTokens: number;
  projectedCostUsd: number;
}

export function assertValidGeminiKey(rawKey?: string): string {
  const key = (rawKey || '').trim();
  if (isPlaceholderOrEmptyKey(key)) {
    throw new Error(
      '[AEL Live Eval] GEMINI_API_KEY is missing or set to a placeholder. Live evaluation requires a real GEMINI_API_KEY and never falls back to simulation.'
    );
  }
  return key;
}

export interface ProviderPricingEntry {
  provider: LiveProviderType;
  model: string;
  input: number;
  output: number;
  reasoning: number;
  pricing_source: string;
  pricing_last_updated: string;
  is_estimated_rate_card: true;
}

export const PRICING_CATALOG_LAST_UPDATED = '2026-11-16';

const PROVIDER_PRICING_CATALOG: Record<LiveProviderType, Record<string, Omit<ProviderPricingEntry, 'provider' | 'model' | 'is_estimated_rate_card'>>> = {
  gemini: {
    'gemini-3.5-flash-lite': {
      input: 0.30,
      output: 2.50,
      reasoning: 2.50,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) — Standard paid tier snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-2.5-flash': {
      input: 0.15,
      output: 0.60,
      reasoning: 0.60,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — standard rate card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-2.5-flash-lite': {
      input: 0.10,
      output: 0.40,
      reasoning: 0.40,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Flash-Lite rate card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-2.5-pro': {
      input: 1.25,
      output: 10.0,
      reasoning: 10.0,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Pro <=200k tier snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-3-flash-preview': {
      input: 0.50,
      output: 3.00,
      reasoning: 3.00,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Gemini 3 Flash preview snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-3-pro-preview': {
      input: 2.00,
      output: 12.00,
      reasoning: 12.00,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Gemini 3 Pro preview snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-3.1-flash-lite': {
      input: 0.10,
      output: 0.40,
      reasoning: 0.40,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Flash-Lite snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-4-hydrogen': {
      input: 0.50,
      output: 3.00,
      reasoning: 3.00,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Flash-tier rate card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gemini-4-argon': {
      input: 2.00,
      output: 12.00,
      reasoning: 12.00,
      pricing_source: 'Google Gemini API Pricing (https://ai.google.dev/gemini-api/docs/pricing) — Pro-tier rate card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
  },
  openai: {
    'gpt-4o-mini': {
      input: 0.15,
      output: 0.60,
      reasoning: 0.60,
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — gpt-4o-mini standard snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gpt-4o-mini-2024-07-18': {
      input: 0.15,
      output: 0.60,
      reasoning: 0.60,
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — gpt-4o-mini dated snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'gpt-4o': {
      input: 2.50,
      output: 10.00,
      reasoning: 10.00,
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — gpt-4o standard snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'o3-mini': {
      input: 1.10,
      output: 4.40,
      reasoning: 4.40,
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — o3-mini standard snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'o1': {
      input: 15.00,
      output: 60.00,
      reasoning: 60.00,
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — o1 standard snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
  },
  anthropic: {
    'claude-3-5-haiku-20241022': {
      input: 0.80,
      output: 4.00,
      reasoning: 4.00,
      pricing_source: 'Anthropic Pricing (https://www.anthropic.com/pricing) — Claude 3.5 Haiku snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'claude-3-7-sonnet-20250219': {
      input: 3.00,
      output: 15.00,
      reasoning: 15.00,
      pricing_source: 'Anthropic Pricing (https://www.anthropic.com/pricing) — Claude 3.7 Sonnet snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
    'claude-sonnet-4-20250514': {
      input: 3.00,
      output: 15.00,
      reasoning: 15.00,
      pricing_source: 'Anthropic Pricing (https://www.anthropic.com/pricing) — Claude Sonnet 4 snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
    },
  },
};

export function getProviderPricing(providerType: LiveProviderType, model: string): ProviderPricingEntry {
  const normalizedModel = (model || '').trim();
  const catalog = PROVIDER_PRICING_CATALOG[providerType];
  if (!catalog) {
    throw new Error(`[AEL Pricing Error] Unknown provider '${String(providerType)}'.`);
  }
  const entry = catalog[normalizedModel];
  if (!entry) {
    throw new Error(
      `[AEL Pricing Error] Unknown or uncatalogued model '${normalizedModel}' for provider '${providerType}'. Refusing to silently apply an unrelated default rate. Supported models: ${Object.keys(catalog).join(', ')}.`
    );
  }
  return {
    provider: providerType,
    model: normalizedModel,
    ...entry,
    is_estimated_rate_card: true,
  };
}

export interface ModelCostBreakdownEntry {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  reasoning_cost_usd: number;
  total_cost_usd: number;
  pricing_source: string;
  pricing_last_updated: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
  reasoning_cost_per_million: number;
  billing_basis: 'estimated_from_provider_usage_and_profile_rates';
  cost_estimation_status: 'estimated_only_not_provider_billed';
  provider_billed_cost_reported: false;
}

export interface BucketCostSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  reasoning_cost_usd: number;
  total_cost_usd: number;
  models: Record<string, ModelCostBreakdownEntry>;
}

export interface BucketBreakdown {
  baseline: BucketCostSummary;
  ael: BucketCostSummary;
  verifiers: BucketCostSummary;
}

/**
 * Resolves exact catalog pricing for a single provider call using the ACTUAL model returned
 * by the provider. Rejects unknown/uncatalogued models with `[AEL Pricing Error]` instead of
 * falling back to the primary model's rate card.
 */
export function resolveCallCostBreakdown(
  providerType: LiveProviderType,
  call: Pick<
    CallUsageRecord,
    'role' | 'requested_model' | 'model' | 'input_tokens' | 'output_tokens' | 'reasoning_tokens' | 'total_tokens' | 'provider_source' | 'usage_source'
  >
): { record: CallUsageRecord; pricing: ProviderPricingEntry } {
  const pricing = getProviderPricing(providerType, call.model);
  const input_cost_usd = Number(((call.input_tokens / 1_000_000) * pricing.input).toFixed(8));
  const output_cost_usd = Number(((call.output_tokens / 1_000_000) * pricing.output).toFixed(8));
  const reasoning_cost_usd = Number(((call.reasoning_tokens / 1_000_000) * pricing.reasoning).toFixed(8));
  const cost_usd = Number((input_cost_usd + output_cost_usd + reasoning_cost_usd).toFixed(6));

  return {
    pricing,
    record: {
      role: call.role,
      requested_model: call.requested_model,
      model: pricing.model,
      input_tokens: call.input_tokens,
      output_tokens: call.output_tokens,
      reasoning_tokens: call.reasoning_tokens,
      total_tokens: call.total_tokens,
      input_cost_usd,
      output_cost_usd,
      reasoning_cost_usd,
      cost_usd,
      billing_basis: 'estimated_from_provider_usage_and_profile_rates',
      cost_estimation_status: 'estimated_only_not_provider_billed',
      provider_billed_cost_reported: false,
      provider_source: call.provider_source,
      usage_source: call.usage_source,
    },
  };
}

function summarizeCallsForBucket(
  providerType: LiveProviderType,
  calls: CallUsageRecord[]
): BucketCostSummary {
  const models: Record<string, ModelCostBreakdownEntry> = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalTokens = 0;
  let totalInputCost = 0;
  let totalOutputCost = 0;
  let totalReasoningCost = 0;
  let totalCostUsd = 0;

  for (const rawCall of calls) {
    const { record, pricing } = resolveCallCostBreakdown(providerType, rawCall);
    totalInput += record.input_tokens;
    totalOutput += record.output_tokens;
    totalReasoning += record.reasoning_tokens;
    totalTokens += record.total_tokens;
    totalInputCost += record.input_cost_usd;
    totalOutputCost += record.output_cost_usd;
    totalReasoningCost += record.reasoning_cost_usd;
    totalCostUsd += record.cost_usd;

    const existing = models[record.model];
    if (!existing) {
      models[record.model] = {
        model: record.model,
        calls: 1,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        reasoning_tokens: record.reasoning_tokens,
        total_tokens: record.total_tokens,
        input_cost_usd: Number(record.input_cost_usd.toFixed(8)),
        output_cost_usd: Number(record.output_cost_usd.toFixed(8)),
        reasoning_cost_usd: Number(record.reasoning_cost_usd.toFixed(8)),
        total_cost_usd: Number(record.cost_usd.toFixed(6)),
        pricing_source: pricing.pricing_source,
        pricing_last_updated: pricing.pricing_last_updated,
        input_cost_per_million: pricing.input,
        output_cost_per_million: pricing.output,
        reasoning_cost_per_million: pricing.reasoning,
        billing_basis: 'estimated_from_provider_usage_and_profile_rates',
        cost_estimation_status: 'estimated_only_not_provider_billed',
        provider_billed_cost_reported: false,
      };
    } else {
      existing.calls += 1;
      existing.input_tokens += record.input_tokens;
      existing.output_tokens += record.output_tokens;
      existing.reasoning_tokens += record.reasoning_tokens;
      existing.total_tokens += record.total_tokens;
      existing.input_cost_usd = Number((existing.input_cost_usd + record.input_cost_usd).toFixed(8));
      existing.output_cost_usd = Number((existing.output_cost_usd + record.output_cost_usd).toFixed(8));
      existing.reasoning_cost_usd = Number((existing.reasoning_cost_usd + record.reasoning_cost_usd).toFixed(8));
      existing.total_cost_usd = Number((existing.total_cost_usd + record.cost_usd).toFixed(6));
    }
  }

  return {
    calls: calls.length,
    input_tokens: totalInput,
    output_tokens: totalOutput,
    reasoning_tokens: totalReasoning,
    total_tokens: totalTokens,
    input_cost_usd: Number(totalInputCost.toFixed(8)),
    output_cost_usd: Number(totalOutputCost.toFixed(8)),
    reasoning_cost_usd: Number(totalReasoningCost.toFixed(8)),
    total_cost_usd: Number(totalCostUsd.toFixed(6)),
    models,
  };
}

export function aggregateCallCostRecords(
  providerType: LiveProviderType,
  buckets: {
    baseline: CallUsageRecord[];
    ael: CallUsageRecord[];
    verifiers: CallUsageRecord[];
  }
): {
  per_model_cost_breakdown: Record<string, ModelCostBreakdownEntry>;
  bucket_breakdown: BucketBreakdown;
} {
  const baselineSummary = summarizeCallsForBucket(providerType, buckets.baseline);
  const aelSummary = summarizeCallsForBucket(providerType, buckets.ael);
  const verifiersSummary = summarizeCallsForBucket(providerType, buckets.verifiers);
  const allSummary = summarizeCallsForBucket(providerType, [
    ...buckets.baseline,
    ...buckets.ael,
    ...buckets.verifiers,
  ]);

  return {
    per_model_cost_breakdown: allSummary.models,
    bucket_breakdown: {
      baseline: baselineSummary,
      ael: aelSummary,
      verifiers: verifiersSummary,
    },
  };
}

export function buildLiveProviderProfile(providerType: LiveProviderType, model?: string): ProviderProfile {
  if (providerType === 'gemini') {
    const resolvedModel = (model || process.env.AEL_LIVE_MODEL || 'gemini-2.5-flash').trim();
    const pricing = getProviderPricing('gemini', resolvedModel);
    return {
      name: 'live_gemini',
      type: 'gemini',
      api_key_env: 'GEMINI_API_KEY',
      default_model: resolvedModel,
      cheap_model: 'gemini-2.5-flash-lite',
      reasoning_model: 'gemini-2.5-pro',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: pricing.input,
      output_cost_per_million: pricing.output,
      reasoning_cost_per_million: pricing.reasoning,
    };
  }
  if (providerType === 'openai') {
    const resolvedModel = (model || process.env.AEL_LIVE_MODEL || 'gpt-4o-mini').trim();
    const pricing = getProviderPricing('openai', resolvedModel);
    return {
      name: 'live_openai',
      type: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_model: resolvedModel,
      cheap_model: 'gpt-4o-mini',
      reasoning_model: 'o3-mini',
      supports_reasoning_effort: true,
      supports_logprobs: true,
      input_cost_per_million: pricing.input,
      output_cost_per_million: pricing.output,
      reasoning_cost_per_million: pricing.reasoning,
    };
  }
  const resolvedModel = (model || process.env.AEL_LIVE_MODEL || 'claude-3-5-haiku-20241022').trim();
  const pricing = getProviderPricing('anthropic', resolvedModel);
  return {
    name: 'live_anthropic',
    type: 'anthropic',
    api_key_env: 'ANTHROPIC_API_KEY',
    default_model: resolvedModel,
    cheap_model: 'claude-3-5-haiku-20241022',
    reasoning_model: 'claude-3-7-sonnet-20250219',
    supports_reasoning_effort: true,
    supports_logprobs: false,
    input_cost_per_million: pricing.input,
    output_cost_per_million: pricing.output,
    reasoning_cost_per_million: pricing.reasoning,
  };
}

/**
 * Resolves live provider profile strictly from configured environment credentials.
 * Never falls back to mock or synthetic simulation when keys are absent or invalid.
 */
export function resolveLiveProviderProfile(options: {
  provider?: LiveProviderType;
  model?: string;
} = {}): { profile: ProviderProfile; credentialStatus: 'live_credentials_present' } {
  const requested = options.provider;
  if (requested) {
    if (!['gemini', 'openai', 'anthropic'].includes(requested)) {
      throw new Error(
        `[AEL Benchmark Error] Unsupported provider '${String(requested)}'. Allowed live providers: gemini, openai, anthropic.`
      );
    }
    const envVar =
      requested === 'gemini' ? 'GEMINI_API_KEY' : requested === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (isPlaceholderOrEmptyKey(process.env[envVar])) {
      throw new Error(
        `[AEL Benchmark Error] Missing or invalid credentials in ${envVar} for provider '${requested}'. Live benchmark execution requires valid provider credentials and will never fall back to simulation.`
      );
    }
    return {
      profile: buildLiveProviderProfile(requested, options.model),
      credentialStatus: 'live_credentials_present',
    };
  }

  if (!isPlaceholderOrEmptyKey(process.env.GEMINI_API_KEY)) {
    return {
      profile: buildLiveProviderProfile('gemini', options.model),
      credentialStatus: 'live_credentials_present',
    };
  }
  if (!isPlaceholderOrEmptyKey(process.env.OPENAI_API_KEY)) {
    return {
      profile: buildLiveProviderProfile('openai', options.model),
      credentialStatus: 'live_credentials_present',
    };
  }
  if (!isPlaceholderOrEmptyKey(process.env.ANTHROPIC_API_KEY)) {
    return {
      profile: buildLiveProviderProfile('anthropic', options.model),
      credentialStatus: 'live_credentials_present',
    };
  }

  throw new Error(
    '[AEL Benchmark Error] Missing live provider credentials. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY. Simulated benchmarks have been removed and are never used as a fallback.'
  );
}

export function estimateProjectedEvalCost(params: {
  queries: string[];
  promptOverheadCharsPerCall: number;
  callsPerQuery: number;
  estimatedOutputTokensPerCall: number;
  estimatedReasoningTokensPerCall: number;
  provider: ProviderProfile;
}): ProjectedCostBreakdown {
  const queryCount = params.queries.length;
  const calls = queryCount * params.callsPerQuery;

  // Pre-execution budget guard upper bound only (actual recorded tokens come strictly from provider usage metadata)
  const totalQueryInputTokens = params.queries.reduce(
    (sum, q) => sum + Math.ceil((q.length + params.promptOverheadCharsPerCall) / 4),
    0
  );
  const projectedInputTokens = totalQueryInputTokens * params.callsPerQuery;
  const projectedOutputTokens = calls * params.estimatedOutputTokensPerCall;
  const projectedReasoningTokens = calls * params.estimatedReasoningTokensPerCall;

  const inputCost = (projectedInputTokens / 1_000_000) * params.provider.input_cost_per_million;
  const outputCost = (projectedOutputTokens / 1_000_000) * params.provider.output_cost_per_million;
  const reasoningCost = (projectedReasoningTokens / 1_000_000) * params.provider.reasoning_cost_per_million;

  return {
    queryCount,
    callsPerQuery: params.callsPerQuery,
    projectedInputTokens,
    projectedOutputTokens,
    projectedReasoningTokens,
    projectedCostUsd: Number((inputCost + outputCost + reasoningCost).toFixed(6)),
  };
}

export function assertWithinSpendingGuard(
  projectedOrActualCostUsd: number,
  maxCostUsd: number = MAX_LIVE_EVAL_COST_USD,
  contextLabel: string = 'live-eval'
): void {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error(`[AEL Spending Guard ABORT][${contextLabel}] Invalid cost limit: ${maxCostUsd}`);
  }
  if (projectedOrActualCostUsd > maxCostUsd) {
    throw new Error(
      `[AEL Spending Guard ABORT][${contextLabel}] Projected/cumulative cost $${projectedOrActualCostUsd.toFixed(6)} exceeds maximum budget cap $${maxCostUsd.toFixed(2)}. Aborting to prevent unexpected spend.`
    );
  }
}
