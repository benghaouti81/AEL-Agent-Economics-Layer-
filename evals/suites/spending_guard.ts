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

export type PricingServiceTier = 'standard' | 'batch' | 'flex' | 'priority' | 'contributor';
export type PricingVerificationStatus = 'verified_official' | 'reference_snapshot' | 'unverified';
export type ContextCachingSupport = 'explicit_and_implicit' | 'implicit_only' | 'unsupported';

export interface ServiceTierPricing {
  input_per_million: number;
  output_per_million: number;
  reasoning_per_million: number;
  cached_input_per_million: number | null;
  notes?: string;
}

export interface ScheduledRateChange {
  effective_from: string;
  tiers: Partial<Record<PricingServiceTier, ServiceTierPricing>>;
}

export interface CatalogModelMetadata {
  provider: LiveProviderType;
  model: string;
  pricing_status: PricingVerificationStatus;
  output_includes_thinking: boolean;
  caching_support: ContextCachingSupport;
  pricing_source: string;
  pricing_last_updated: string;
  effective_date_range: string;
  tiers: Partial<Record<PricingServiceTier, ServiceTierPricing>> | null;
  scheduled_rate_change?: ScheduledRateChange;
}

export interface ProviderPricingEntry {
  provider: LiveProviderType;
  model: string;
  service_tier: PricingServiceTier;
  pricing_status: PricingVerificationStatus;
  input: number;
  output: number;
  reasoning: number;
  cached_input: number | null;
  caching_support: ContextCachingSupport;
  output_includes_thinking: boolean;
  tiers: Partial<Record<PricingServiceTier, ServiceTierPricing>>;
  pricing_source: string;
  pricing_last_updated: string;
  effective_date_range: string;
  scheduled_rate_change?: ScheduledRateChange;
  is_estimated_rate_card: true;
}

export const PRICING_CATALOG_LAST_UPDATED = '2026-11-16';

const OFFICIAL_GEMINI_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

type RawCatalogEntry = Omit<CatalogModelMetadata, 'provider' | 'model'>;

const PROVIDER_PRICING_CATALOG: Record<LiveProviderType, Record<string, RawCatalogEntry>> = {
  gemini: {
    'gemini-4-hydrogen': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'implicit_only',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-4-hydrogen) — verified official multi-tier rates (output includes thinking tokens; implicit caching only)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'active as of 2026-11-16 (no scheduled expiration in official docs)',
      tiers: {
        standard: { input_per_million: 1.50, output_per_million: 7.50, reasoning_per_million: 7.50, cached_input_per_million: 0.075 },
        batch: { input_per_million: 0.75, output_per_million: 3.75, reasoning_per_million: 3.75, cached_input_per_million: 0.0375 },
        flex: { input_per_million: 0.75, output_per_million: 3.75, reasoning_per_million: 3.75, cached_input_per_million: 0.0375 },
        priority: { input_per_million: 2.70, output_per_million: 13.50, reasoning_per_million: 13.50, cached_input_per_million: 0.135 },
        contributor: { input_per_million: 0.75, output_per_million: 3.75, reasoning_per_million: 3.75, cached_input_per_million: 0.0375, notes: 'Invite-only Contributor tier' },
      },
    },
    'gemini-4-argon': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'implicit_only',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-4-argon) — verified official multi-tier rates (output includes thinking tokens; implicit caching only; no Free tier)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'through 2026-11-30 ($2.00/$10.00 Standard, $1.00/$5.00 Batch/Flex, $3.60/$18.00 Priority); increases starting 2026-12-01 ($4.00/$20.00 Standard, $2.00/$10.00 Batch/Flex, $7.20/$36.00 Priority)',
      tiers: {
        standard: { input_per_million: 2.00, output_per_million: 10.00, reasoning_per_million: 10.00, cached_input_per_million: 0.10, notes: 'Effective through 2026-11-30' },
        batch: { input_per_million: 1.00, output_per_million: 5.00, reasoning_per_million: 5.00, cached_input_per_million: 0.05, notes: 'Effective through 2026-11-30' },
        flex: { input_per_million: 1.00, output_per_million: 5.00, reasoning_per_million: 5.00, cached_input_per_million: 0.05, notes: 'Effective through 2026-11-30' },
        priority: { input_per_million: 3.60, output_per_million: 18.00, reasoning_per_million: 18.00, cached_input_per_million: 0.18, notes: 'Effective through 2026-11-30' },
        contributor: { input_per_million: 1.00, output_per_million: 5.00, reasoning_per_million: 5.00, cached_input_per_million: 0.05, notes: 'Invite-only Contributor tier' },
      },
      scheduled_rate_change: {
        effective_from: '2026-12-01',
        tiers: {
          standard: { input_per_million: 4.00, output_per_million: 20.00, reasoning_per_million: 20.00, cached_input_per_million: 0.20 },
          batch: { input_per_million: 2.00, output_per_million: 10.00, reasoning_per_million: 10.00, cached_input_per_million: 0.10 },
          flex: { input_per_million: 2.00, output_per_million: 10.00, reasoning_per_million: 10.00, cached_input_per_million: 0.10 },
          priority: { input_per_million: 7.20, output_per_million: 36.00, reasoning_per_million: 36.00, cached_input_per_million: 0.36 },
          contributor: { input_per_million: 1.00, output_per_million: 5.00, reasoning_per_million: 5.00, cached_input_per_million: 0.05, notes: 'Invite-only Contributor tier' },
        },
      },
    },
    'gemini-3.5-flash-lite': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-3.5-flash-lite) — verified official multi-tier rates (output includes thinking tokens)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'active as of 2026-11-16 (no scheduled expiration in official docs)',
      tiers: {
        standard: { input_per_million: 0.30, output_per_million: 2.50, reasoning_per_million: 2.50, cached_input_per_million: 0.03 },
        batch: { input_per_million: 0.15, output_per_million: 1.25, reasoning_per_million: 1.25, cached_input_per_million: 0.015 },
        flex: { input_per_million: 0.15, output_per_million: 1.25, reasoning_per_million: 1.25, cached_input_per_million: 0.02 },
        priority: { input_per_million: 0.54, output_per_million: 4.50, reasoning_per_million: 4.50, cached_input_per_million: 0.05 },
      },
    },
    'gemini-3.1-flash-lite': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-3.1-flash-lite) — verified official multi-tier text/image/video rates (audio input $0.50 Standard; output includes thinking tokens)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'active as of 2026-11-16 (no scheduled expiration in official docs)',
      tiers: {
        standard: { input_per_million: 0.25, output_per_million: 1.50, reasoning_per_million: 1.50, cached_input_per_million: 0.025 },
        batch: { input_per_million: 0.125, output_per_million: 0.75, reasoning_per_million: 0.75, cached_input_per_million: 0.0125 },
        flex: { input_per_million: 0.125, output_per_million: 0.75, reasoning_per_million: 0.75, cached_input_per_million: 0.0125 },
        priority: { input_per_million: 0.45, output_per_million: 2.70, reasoning_per_million: 2.70, cached_input_per_million: 0.045 },
      },
    },
    'gemini-3-flash-preview': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-3-flash-preview) — verified official multi-tier text/image/video rates (audio input $1.00 Standard; output includes thinking tokens)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'active as of 2026-11-16 (preview model)',
      tiers: {
        standard: { input_per_million: 0.50, output_per_million: 3.00, reasoning_per_million: 3.00, cached_input_per_million: 0.05 },
        batch: { input_per_million: 0.25, output_per_million: 1.50, reasoning_per_million: 1.50, cached_input_per_million: 0.05, notes: 'Context caching price matches Standard tier' },
        flex: { input_per_million: 0.25, output_per_million: 1.50, reasoning_per_million: 1.50, cached_input_per_million: 0.05, notes: 'Context caching price matches Standard tier' },
        priority: { input_per_million: 0.90, output_per_million: 5.40, reasoning_per_million: 5.40, cached_input_per_million: 0.09 },
      },
    },
    'gemini-3.1-pro-preview': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-3.1-pro-preview) — verified official multi-tier <=200k prompt rates (output includes thinking tokens)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'active as of 2026-11-16 (prompts <=200k tier recorded; preview model)',
      tiers: {
        standard: { input_per_million: 2.00, output_per_million: 12.00, reasoning_per_million: 12.00, cached_input_per_million: 0.20, notes: 'Prompts <=200k tokens' },
        batch: { input_per_million: 1.00, output_per_million: 6.00, reasoning_per_million: 6.00, cached_input_per_million: 0.20, notes: 'Prompts <=200k tokens; caching same as Standard' },
        flex: { input_per_million: 1.00, output_per_million: 6.00, reasoning_per_million: 6.00, cached_input_per_million: 0.20, notes: 'Prompts <=200k tokens; caching same as Standard' },
        priority: { input_per_million: 3.60, output_per_million: 21.60, reasoning_per_million: 21.60, cached_input_per_million: 0.36, notes: 'Prompts <=200k tokens' },
      },
    },
    'gemini-3-pro-preview': {
      pricing_status: 'unverified',
      output_includes_thinking: true,
      caching_support: 'unsupported',
      pricing_source: `Unverified — 'gemini-3-pro-preview' has no pricing table in Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}) as of ${PRICING_CATALOG_LAST_UPDATED}; rates cannot be verified and are never labeled official.`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `unverified (absent from official pricing docs as of ${PRICING_CATALOG_LAST_UPDATED})`,
      tiers: null,
    },
    'gemini-2.5-flash': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-2.5-flash) — verified official multi-tier text/image/video rates (output includes thinking tokens)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'through 2026-11-30 (deprecated; auto-routes to gemini-3.5-flash-lite effective 2026-12-01 at same $0.30/$2.50 Standard rates)',
      tiers: {
        standard: { input_per_million: 0.30, output_per_million: 2.50, reasoning_per_million: 2.50, cached_input_per_million: 0.03 },
        batch: { input_per_million: 0.15, output_per_million: 1.25, reasoning_per_million: 1.25, cached_input_per_million: 0.03 },
        flex: { input_per_million: 0.15, output_per_million: 1.25, reasoning_per_million: 1.25, cached_input_per_million: 0.03 },
        priority: { input_per_million: 0.54, output_per_million: 4.50, reasoning_per_million: 4.50, cached_input_per_million: 0.054 },
      },
    },
    'gemini-2.5-flash-lite': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-2.5-flash-lite) — verified official multi-tier text/image/video rates (output includes thinking tokens)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'active as of 2026-11-16 (no scheduled expiration in official docs)',
      tiers: {
        standard: { input_per_million: 0.10, output_per_million: 0.40, reasoning_per_million: 0.40, cached_input_per_million: 0.01 },
        batch: { input_per_million: 0.05, output_per_million: 0.20, reasoning_per_million: 0.20, cached_input_per_million: 0.01 },
        flex: { input_per_million: 0.05, output_per_million: 0.20, reasoning_per_million: 0.20, cached_input_per_million: 0.01 },
        priority: { input_per_million: 0.18, output_per_million: 0.72, reasoning_per_million: 0.72, cached_input_per_million: 0.018 },
      },
    },
    'gemini-2.5-pro': {
      pricing_status: 'verified_official',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: `Google Gemini API Pricing (${OFFICIAL_GEMINI_PRICING_URL}#gemini-2.5-pro) — verified official multi-tier <=200k prompt rates (output includes thinking tokens; >200k prompt tier higher)`,
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: 'through 2026-11-30 (deprecated; auto-routes to gemini-3.8-flash effective 2026-12-01)',
      tiers: {
        standard: { input_per_million: 1.25, output_per_million: 10.00, reasoning_per_million: 10.00, cached_input_per_million: 0.125, notes: 'Prompts <=200k tokens (>200k: $2.50/$15.00)' },
        batch: { input_per_million: 0.625, output_per_million: 5.00, reasoning_per_million: 5.00, cached_input_per_million: 0.125, notes: 'Prompts <=200k tokens (>200k: $1.25/$7.50)' },
        flex: { input_per_million: 0.625, output_per_million: 5.00, reasoning_per_million: 5.00, cached_input_per_million: 0.125, notes: 'Prompts <=200k tokens (>200k: $1.25/$7.50)' },
        priority: { input_per_million: 2.25, output_per_million: 18.00, reasoning_per_million: 18.00, cached_input_per_million: 0.225, notes: 'Prompts <=200k tokens (>200k: $4.50/$27.00)' },
      },
    },
  },
  openai: {
    'gpt-4o-mini': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: false,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — gpt-4o-mini standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 0.15, output_per_million: 0.60, reasoning_per_million: 0.60, cached_input_per_million: 0.075 },
      },
    },
    'gpt-4o-mini-2024-07-18': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: false,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — gpt-4o-mini dated standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 0.15, output_per_million: 0.60, reasoning_per_million: 0.60, cached_input_per_million: 0.075 },
      },
    },
    'gpt-4o': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: false,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — gpt-4o standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 2.50, output_per_million: 10.00, reasoning_per_million: 10.00, cached_input_per_million: 1.25 },
      },
    },
    'o3-mini': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — o3-mini standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 1.10, output_per_million: 4.40, reasoning_per_million: 4.40, cached_input_per_million: 0.55 },
      },
    },
    'o1': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'OpenAI API Pricing (https://openai.com/api/pricing) — o1 standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 15.00, output_per_million: 60.00, reasoning_per_million: 60.00, cached_input_per_million: 7.50 },
      },
    },
  },
  anthropic: {
    'claude-3-5-haiku-20241022': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: false,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'Anthropic Pricing (https://www.anthropic.com/pricing) — Claude 3.5 Haiku standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 0.80, output_per_million: 4.00, reasoning_per_million: 4.00, cached_input_per_million: 0.08 },
      },
    },
    'claude-3-7-sonnet-20250219': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'Anthropic Pricing (https://www.anthropic.com/pricing) — Claude 3.7 Sonnet standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 3.00, output_per_million: 15.00, reasoning_per_million: 15.00, cached_input_per_million: 0.30 },
      },
    },
    'claude-sonnet-4-20250514': {
      pricing_status: 'reference_snapshot',
      output_includes_thinking: true,
      caching_support: 'explicit_and_implicit',
      pricing_source: 'Anthropic Pricing (https://www.anthropic.com/pricing) — Claude Sonnet 4 standard rate-card snapshot',
      pricing_last_updated: PRICING_CATALOG_LAST_UPDATED,
      effective_date_range: `reference snapshot as of ${PRICING_CATALOG_LAST_UPDATED}`,
      tiers: {
        standard: { input_per_million: 3.00, output_per_million: 15.00, reasoning_per_million: 15.00, cached_input_per_million: 0.30 },
      },
    },
  },
};

export function listCatalogModels(providerType: LiveProviderType): string[] {
  const catalog = PROVIDER_PRICING_CATALOG[providerType];
  if (!catalog) {
    throw new Error(`[AEL Pricing Error] Unknown provider '${String(providerType)}'.`);
  }
  return Object.keys(catalog);
}

export function inspectProviderPricingCatalogEntry(
  providerType: LiveProviderType,
  model: string
): CatalogModelMetadata {
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
  };
}

export function getProviderPricing(
  providerType: LiveProviderType,
  model: string,
  tier: PricingServiceTier = 'standard',
  referenceDate: string = PRICING_CATALOG_LAST_UPDATED
): ProviderPricingEntry {
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
  if (entry.pricing_status === 'unverified' || !entry.tiers) {
    throw new Error(
      `[AEL Pricing Error] Model '${normalizedModel}' for provider '${providerType}' is marked 'unverified' (absent from official pricing docs) and cannot be used for official cost calculation.`
    );
  }

  let effectiveTiers = entry.tiers;
  if (entry.scheduled_rate_change && referenceDate >= entry.scheduled_rate_change.effective_from) {
    effectiveTiers = {
      ...entry.tiers,
      ...entry.scheduled_rate_change.tiers,
    };
  }

  const tierPricing = effectiveTiers[tier];
  if (!tierPricing) {
    throw new Error(
      `[AEL Pricing Error] Service tier '${tier}' is not defined for model '${normalizedModel}' (${providerType}). Available tiers: ${Object.keys(effectiveTiers).join(', ')}.`
    );
  }

  return {
    provider: providerType,
    model: normalizedModel,
    service_tier: tier,
    pricing_status: entry.pricing_status,
    input: tierPricing.input_per_million,
    output: tierPricing.output_per_million,
    reasoning: tierPricing.reasoning_per_million,
    cached_input: tierPricing.cached_input_per_million,
    caching_support: entry.caching_support,
    output_includes_thinking: entry.output_includes_thinking,
    tiers: effectiveTiers,
    pricing_source: entry.pricing_source,
    pricing_last_updated: entry.pricing_last_updated,
    effective_date_range: entry.effective_date_range,
    ...(entry.scheduled_rate_change ? { scheduled_rate_change: entry.scheduled_rate_change } : {}),
    is_estimated_rate_card: true,
  };
}

export interface ModelCostBreakdownEntry {
  model: string;
  service_tier?: PricingServiceTier;
  pricing_status?: PricingVerificationStatus;
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
  effective_date_range?: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
  reasoning_cost_per_million: number;
  cached_input_cost_per_million?: number | null;
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
 * by the provider. Rejects unknown/uncatalogued/unverified models with `[AEL Pricing Error]`
 * instead of falling back to the primary model's rate card.
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
        service_tier: pricing.service_tier,
        pricing_status: pricing.pricing_status,
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
        effective_date_range: pricing.effective_date_range,
        input_cost_per_million: pricing.input,
        output_cost_per_million: pricing.output,
        reasoning_cost_per_million: pricing.reasoning,
        cached_input_cost_per_million: pricing.cached_input,
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
