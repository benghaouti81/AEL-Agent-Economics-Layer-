/**
 * AEL — Agent Economics Layer
 * Configuration & Presets (Zod)
 * @license Apache-2.0
 */

import { z } from 'zod';
import fs from 'node:fs';
import { load } from 'js-yaml';
import { ScalingRegimeSchema } from '../models/contracts.js';

export const ProviderProfileSchema = z.object({
  name: z.string(),
  type: z.enum(['openai', 'anthropic', 'gemini', 'mock']),
  base_url: z.string().optional(),
  api_key_env: z.string().default('GEMINI_API_KEY'),
  default_model: z.string(),
  cheap_model: z.string(),
  reasoning_model: z.string(),
  supports_reasoning_effort: z.boolean().default(true),
  supports_logprobs: z.boolean().default(false),
  // Pricing per 1M tokens in USD
  input_cost_per_million: z.number().default(0.15),
  output_cost_per_million: z.number().default(0.60),
  reasoning_cost_per_million: z.number().default(0.60),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const PresetPolicySchema = z.object({
  name: z.string(),
  description: z.string(),
  regime: ScalingRegimeSchema,
  initial_reasoning_effort: z.enum(['none', 'low', 'medium', 'high']).default('low'),
  effort_ladder: z.array(z.enum(['none', 'low', 'medium', 'high'])).default(['none', 'low', 'medium']),
  k_samples: z.number().int().min(1).max(7).default(3),
  evidence_confidence_threshold: z.number().min(0).max(1).default(0.70),
  max_retries: z.number().int().min(1).max(5).default(3),
  max_latency_ms: z.number().default(10000),
  cost_cap_per_request_usd: z.number().default(0.05),
});
export type PresetPolicy = z.infer<typeof PresetPolicySchema>;

export const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rolling_window: z.number().int().min(5).max(100).default(20),
  min_net_savings_usd: z.number().default(0.0), // If rolling net savings <= 0, trip
  max_error_rate: z.number().min(0).max(1).default(0.20),
});
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

export const TelemetryConfigSchema = z.object({
  log_payloads: z.boolean().default(false), // NEVER log full payloads by default
  anonymize_identifiers: z.boolean().default(true),
  db_path: z.string().default('./data/ael_decisions.db'),
});
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

export const AelConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('0.0.0.0'),
  active_preset: z.enum(['balanced', 'quality_first', 'cost_saver', 'latency_capped']).default('balanced'),
  pass_through: z.boolean().default(false), // Global A/B pass-through
  provider: ProviderProfileSchema.default({
    name: 'default',
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
  }),
  presets: z.record(z.string(), PresetPolicySchema),
  circuit_breaker: CircuitBreakerConfigSchema.default(() => ({
    enabled: true,
    rolling_window: 20,
    min_net_savings_usd: 0.0,
    max_error_rate: 0.20,
  })),
  telemetry: TelemetryConfigSchema.default(() => ({
    log_payloads: false,
    anonymize_identifiers: true,
    db_path: './data/ael_decisions.db',
  })),
});
export type AelConfig = z.infer<typeof AelConfigSchema>;

export const DEFAULT_PRESETS: Record<string, PresetPolicy> = {
  balanced: {
    name: 'balanced',
    description: 'Optimal trade-off: cheap probe first, escalate to medium on uncertainty, max 3 samples',
    regime: 'single',
    initial_reasoning_effort: 'low',
    effort_ladder: ['none', 'low', 'medium'],
    k_samples: 3,
    evidence_confidence_threshold: 0.70,
    max_retries: 3,
    max_latency_ms: 8000,
    cost_cap_per_request_usd: 0.05,
  },
  quality_first: {
    name: 'quality_first',
    description: 'Maximum accuracy: high reasoning effort, self-consistency sample voting k=3',
    regime: 'sample',
    initial_reasoning_effort: 'medium',
    effort_ladder: ['low', 'medium', 'high'],
    k_samples: 3,
    evidence_confidence_threshold: 0.85,
    max_retries: 3,
    max_latency_ms: 15000,
    cost_cap_per_request_usd: 0.15,
  },
  cost_saver: {
    name: 'cost_saver',
    description: 'Aggressive token reduction: zero-compute probe, early stop on agreement, no high tier',
    regime: 'single',
    initial_reasoning_effort: 'none',
    effort_ladder: ['none', 'low'],
    k_samples: 2,
    evidence_confidence_threshold: 0.60,
    max_retries: 2,
    max_latency_ms: 4000,
    cost_cap_per_request_usd: 0.01,
  },
  latency_capped: {
    name: 'latency_capped',
    description: 'Fast response cap under 2 seconds: single trajectory, no sample expansions',
    regime: 'single',
    initial_reasoning_effort: 'low',
    effort_ladder: ['low'],
    k_samples: 1,
    evidence_confidence_threshold: 0.50,
    max_retries: 1,
    max_latency_ms: 2000,
    cost_cap_per_request_usd: 0.02,
  },
};

export function loadConfig(configPath?: string): AelConfig {
  let fileConfig: any = {};
  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    fileConfig = load(raw) || {};
  }
  
  const merged = {
    ...fileConfig,
    presets: {
      ...DEFAULT_PRESETS,
      ...(fileConfig.presets || {}),
    },
  };
  
  return AelConfigSchema.parse(merged);
}
