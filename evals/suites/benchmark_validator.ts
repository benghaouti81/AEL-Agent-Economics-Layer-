/**
 * AEL — Benchmark Evidence Provenance & Acceptance Validator
 * Enforces strict evidence integrity rules:
 * - Only "live_provider" source accepted (never legacy simulator or "unit_test")
 * - Verifiable SHA-256 dataset hash recomputed against canonical evaluated cases
 * - Full provider, exact model pricing provenance, credential status, token accounting, and verifier integrity required
 * - Rejects zero-valid-sample evaluations, failed verifiers, and below-floor accuracy (including 0/N vs 0/N)
 * - Prohibits failed evaluations from emitting misleading savings claims
 * @license Apache-2.0
 */

import crypto from 'node:crypto';
import { BUDGET_EVAL_DATASET_VERSION, getBudgetEvalCanonicalCases } from './budget_eval_suite.js';
import { TOOL_EVAL_DATASET_VERSION, getToolEvalCanonicalCases } from './tool_eval_suite.js';
import type {
  BucketBreakdown,
  ModelCostBreakdownEntry,
  PricingServiceTier,
  PricingVerificationStatus,
} from './spending_guard.js';

export type BenchmarkSource = 'live_provider' | 'unit_test';

export const ALLOWED_LIVE_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;

export const DATASET_HASH_ALGORITHM = 'sha256-canonical-json-v1' as const;

/**
 * Measurement-validity and minimum-competence guardrails.
 *
 * Rationale & Limitations:
 * - These 50% floors are validity guards, not universal statistical theorems: across heterogeneous
 *   open-ended tasks (math, code synthesis, structured JSON extraction, factual recall), 50%
 *   prevents degenerate "0/N baseline vs 0/N AEL (0 pp drop)" or compute-starved garbage-output
 *   runs from passing parity checks.
 * - Limitation: aggregate >= 50% across 4 categories can still mask single-category collapse,
 *   and does not substitute for item-difficulty calibration or confidence intervals.
 */
export const STATISTICAL_AND_VALIDITY_FLOORS = {
  budget_min_baseline_accuracy: 0.50,
  budget_min_ael_accuracy: 0.50,
} as const;

/**
 * Project-specific product & SLA acceptance targets (Definition of Done #1-#3, #7).
 *
 * Rationale & Limitations:
 * - `budget_max_accuracy_drop_pp` (2.0 pp): engineering parity SLA, NOT a statistically powered
 *   non-inferiority margin. On the full 200-query split (`N=200`), 1 query equals 0.5 pp and binomial
 *   SE at p=0.85 is ~2.5 pp; on `--limit 5` (`N=20`), 1 query equals 5.0 pp and binomial SE is ~8-11 pp,
 *   so small `--limit` smoke runs cannot establish statistical non-inferiority.
 * - `budget_min_token_reduction_pct` (50.0%): product economic-value bar requiring reasoning-capable
 *   models where AEL's adaptive effort ladder can eliminate excess thinking tokens.
 * - `budget_max_p95_overhead_ms` (500ms): middleware CPU/SQLite latency SLA excluding upstream LLM I/O.
 * - `tool_selection_accuracy` (0.90) & `tool_dry_run_catches` (3): DoD #1/#2 acceptance bar on 10
 *   selection cases + 3 seeded fault scenarios (`N=10` gives wide binomial 95% CIs ~0.56-0.98).
 */
export const PROJECT_ACCEPTANCE_TARGETS = {
  tool_selection_accuracy: 0.90,
  tool_dry_run_catches: 3,
  budget_min_token_reduction_pct: 50.0,
  budget_max_accuracy_drop_pp: 2.0,
  budget_max_p95_overhead_ms: 500,
} as const;

export const BENCHMARK_QUALITY_FLOORS = {
  ...STATISTICAL_AND_VALIDITY_FLOORS,
  ...PROJECT_ACCEPTANCE_TARGETS,
} as const;

export interface ModelConfigurationSnapshot {
  default_model: string;
  cheap_model: string;
  reasoning_model: string;
  supports_reasoning_effort: boolean;
  supports_logprobs: boolean;
  preset?: string;
  effort_ladder?: string[];
}

export interface CostMethodology {
  billing_basis: 'estimated_from_provider_usage_and_profile_rates' | 'provider_billed';
  cost_estimation_status: 'estimated_only_not_provider_billed' | 'provider_billed_verified';
  provider_billed_cost_reported: boolean;
  usage_source: 'provider_reported';
  currency: 'USD';
  accounting_granularity?: 'per_call_actual_model';
  pricing_model: string;
  service_tier?: PricingServiceTier;
  pricing_status?: PricingVerificationStatus;
  pricing_source: string;
  pricing_last_updated: string;
  effective_date_range?: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
  reasoning_cost_per_million: number;
  cached_input_cost_per_million?: number | null;
  output_includes_thinking?: boolean;
  verification_cost_excluded_from_product_savings: boolean;
  per_model_cost_breakdown?: Record<string, ModelCostBreakdownEntry>;
  bucket_breakdown?: BucketBreakdown;
}

export interface VerifierResultsSummary {
  total_verifications: number;
  passed: number;
  failed: number;
  errored: number;
  methods: string[];
}

export interface BenchmarkValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Canonical JSON serialization (`sha256-canonical-json-v1`):
 * - Arrays preserve exact element order (reordering cases changes the digest).
 * - Plain objects sort own enumerable keys lexicographically and omit `undefined` properties
 *   so equivalent objects serialize identically regardless of JS property insertion order.
 * - Primitives use standard JSON encoding (`null`, booleans, finite numbers, strings).
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : canonicalizeJson(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
      .sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/**
 * Computes lowercase hex SHA-256 over the canonical JSON representation (`sha256-canonical-json-v1`)
 * of the exact evaluated dataset cases. Any case addition, deletion, reordering, or field edit
 * changes the resulting digest.
 */
export function computeDatasetHash(canonicalCases: unknown): string {
  return crypto.createHash('sha256').update(canonicalizeJson(canonicalCases), 'utf8').digest('hex');
}

function containsRawSecretPattern(value: unknown): boolean {
  const s = String(value || '');
  return /\bAIza[0-9A-Za-z_-]{10,}\b|\bsk-[0-9A-Za-z_-]{10,}\b|\bsk-ant-[0-9A-Za-z_-]{10,}\b/.test(s);
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

function isFiniteNonNeg(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function resolveCanonicalDatasetForResult(data: any): {
  resolved: boolean;
  canonicalDataset?: unknown;
  expectedCount?: number;
  error?: string;
} {
  const limitRaw = data.sample_size?.limit_per_category;
  let limitPerCategory: number | undefined;
  if (limitRaw !== undefined && limitRaw !== null) {
    if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw <= 0) {
      return {
        resolved: false,
        error: `Invalid sample_size.limit_per_category '${String(limitRaw)}': expected positive integer or null.`,
      };
    }
    limitPerCategory = limitRaw;
  }

  if (data.dataset_version === BUDGET_EVAL_DATASET_VERSION) {
    if (data.split !== 'held_out' && data.split !== 'tuning') {
      return {
        resolved: false,
        error: `Invalid split '${String(data.split)}' for dataset_version '${data.dataset_version}'.`,
      };
    }
    const cases = getBudgetEvalCanonicalCases(data.split, limitPerCategory);
    return { resolved: true, canonicalDataset: cases, expectedCount: cases.length };
  }

  if (data.dataset_version === TOOL_EVAL_DATASET_VERSION) {
    if (data.split !== 'tool_selection_held_out') {
      return {
        resolved: false,
        error: `Invalid split '${String(data.split)}' for dataset_version '${data.dataset_version}'.`,
      };
    }
    const cases = getToolEvalCanonicalCases(limitPerCategory);
    return {
      resolved: true,
      canonicalDataset: cases,
      expectedCount: cases.selection_cases.length + cases.catch_scenarios.length,
    };
  }

  return {
    resolved: false,
    error: `Unknown dataset_version '${String(data.dataset_version)}': cannot independently recompute canonical dataset hash.`,
  };
}

export function validateBenchmarkResult(
  data: any,
  options: { requirePassingAcceptance?: boolean; datasetCases?: unknown } = { requirePassingAcceptance: true }
): BenchmarkValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Benchmark result is null or not an object.'] };
  }

  // 1. Source classification check (strictly "live_provider")
  if (data.source !== 'live_provider') {
    errors.push(
      `Invalid benchmark source '${String(data.source)}': only 'live_provider' is accepted as benchmark evidence.`
    );
  }
  if (
    String(data.provider_source || '').includes('mock') ||
    String(data.provider || '').includes('mock') ||
    String(data.source || '').includes('mock')
  ) {
    errors.push(`Mock simulator results ('${String(data.provider_source || data.source)}') are strictly prohibited.`);
  }
  if (data.provider_source === 'unit_test' || data.token_usage?.usage_source === 'unit_test') {
    errors.push('Unit test doubles cannot be accepted as benchmark evidence.');
  }

  // 2. Provider, model, credential status & model_config
  if (!isNonEmptyString(data.provider) || !ALLOWED_LIVE_PROVIDERS.includes(data.provider)) {
    errors.push(`Invalid or missing provider '${String(data.provider)}': expected one of ${ALLOWED_LIVE_PROVIDERS.join(', ')}.`);
  }
  if (!isNonEmptyString(data.provider_source) || data.provider_source !== data.provider) {
    errors.push(`Missing or mismatched provider_source '${String(data.provider_source)}' vs provider '${String(data.provider)}'.`);
  }
  if (!isNonEmptyString(data.model) || data.model === 'mock' || data.model === 'mock-model') {
    errors.push(`Invalid or missing exact model identifier: '${String(data.model)}'.`);
  }
  if (!isNonEmptyString(data.credential_status) || data.credential_status !== 'live_credentials_present') {
    errors.push(`Missing or invalid credential_status: '${String(data.credential_status)}'.`);
  }
  if (containsRawSecretPattern(data.credential_status) || containsRawSecretPattern(JSON.stringify(data.model_config || {}))) {
    errors.push('Potential API secret leaked in credential_status or model_config.');
  }
  if (!data.live_api_credentials_present) {
    errors.push('live_api_credentials_present must be true for accepted benchmark evidence.');
  }
  if (!data.model_config || typeof data.model_config !== 'object' || !isNonEmptyString(data.model_config.default_model)) {
    errors.push('Missing model_config metadata.');
  }

  // 3. Split, dataset version/hash + independent hash recomputation, timestamp, valid sample count
  if (!isNonEmptyString(data.split)) {
    errors.push('Missing benchmark split.');
  }
  if (!isNonEmptyString(data.dataset_version)) {
    errors.push('Missing dataset_version.');
  }
  if (data.dataset_hash_algorithm !== DATASET_HASH_ALGORITHM) {
    errors.push(
      `Missing or invalid dataset_hash_algorithm '${String(data.dataset_hash_algorithm)}': expected '${DATASET_HASH_ALGORITHM}'.`
    );
  }
  if (!isNonEmptyString(data.dataset_hash) || !/^[a-f0-9]{64}$/i.test(data.dataset_hash)) {
    errors.push('Missing or invalid SHA-256 dataset_hash.');
  } else if (options.datasetCases !== undefined) {
    const expectedHash = computeDatasetHash(options.datasetCases);
    if (data.dataset_hash.toLowerCase() !== expectedHash) {
      errors.push(
        `Dataset hash mismatch against supplied canonical cases: expected ${expectedHash}, got ${data.dataset_hash}.`
      );
    }
  } else {
    const resolution = resolveCanonicalDatasetForResult(data);
    if (!resolution.resolved) {
      errors.push(resolution.error!);
    } else {
      const expectedHash = computeDatasetHash(resolution.canonicalDataset);
      if (data.dataset_hash.toLowerCase() !== expectedHash) {
        errors.push(
          `Dataset hash mismatch for dataset_version='${data.dataset_version}' split='${data.split}' limit_per_category=${String(data.sample_size?.limit_per_category ?? null)}: expected ${expectedHash}, got ${data.dataset_hash}.`
        );
      }
      const recordedTotal = data.sample_size?.total_queries ?? data.sample_size?.total_cases;
      if (typeof recordedTotal === 'number' && resolution.expectedCount !== undefined && recordedTotal !== resolution.expectedCount) {
        errors.push(
          `Sample count mismatch for canonical dataset (${recordedTotal} recorded vs ${resolution.expectedCount} expected).`
        );
      }
    }
  }
  if (!isNonEmptyString(data.timestamp) || Number.isNaN(Date.parse(data.timestamp))) {
    errors.push(`Invalid or missing evaluation timestamp: '${String(data.timestamp)}'.`);
  }
  const validSamples = data.sample_size?.valid_samples;
  if (typeof validSamples !== 'number' || !Number.isInteger(validSamples) || validSamples <= 0) {
    errors.push(`Zero-valid-sample evaluations cannot be accepted (valid_samples=${String(validSamples)}).`);
  }

  // 4. Cost accounting & pricing provenance
  const costMethod = data.cost_methodology as CostMethodology | undefined;
  if (
    !costMethod ||
    !['estimated_from_provider_usage_and_profile_rates', 'provider_billed'].includes(costMethod.billing_basis) ||
    typeof costMethod.provider_billed_cost_reported !== 'boolean' ||
    costMethod.usage_source !== 'provider_reported' ||
    costMethod.currency !== 'USD' ||
    !isFiniteNonNeg(costMethod.input_cost_per_million) ||
    !isFiniteNonNeg(costMethod.output_cost_per_million) ||
    !isFiniteNonNeg(costMethod.reasoning_cost_per_million)
  ) {
    errors.push('Missing or invalid cost_methodology metadata.');
  } else {
    if (
      costMethod.billing_basis === 'estimated_from_provider_usage_and_profile_rates' &&
      (costMethod.provider_billed_cost_reported !== false ||
        costMethod.cost_estimation_status !== 'estimated_only_not_provider_billed')
    ) {
      errors.push(
        'Estimated rate-card cost must set provider_billed_cost_reported=false and cost_estimation_status="estimated_only_not_provider_billed".'
      );
    }
    if (
      costMethod.billing_basis === 'provider_billed' &&
      (costMethod.provider_billed_cost_reported !== true ||
        costMethod.cost_estimation_status !== 'provider_billed_verified')
    ) {
      errors.push(
        'Provider-billed cost claims require provider_billed_cost_reported=true and cost_estimation_status="provider_billed_verified".'
      );
    }
    if (!isNonEmptyString(costMethod.pricing_model) || costMethod.pricing_model !== data.model) {
      errors.push(
        `Missing or mismatched cost_methodology.pricing_model ('${String(costMethod.pricing_model)}' vs model '${String(data.model)}').`
      );
    }
    if (costMethod.pricing_status === 'unverified') {
      errors.push('cost_methodology.pricing_status is unverified; benchmark evidence cannot claim official pricing from an unverified model.');
    }
    if (!isNonEmptyString(costMethod.pricing_source)) {
      errors.push('Missing cost_methodology.pricing_source.');
    }
    if (!isNonEmptyString(costMethod.pricing_last_updated) || !/^\d{4}-\d{2}-\d{2}$/.test(costMethod.pricing_last_updated)) {
      errors.push(
        `Missing or invalid cost_methodology.pricing_last_updated ('${String(costMethod.pricing_last_updated)}'; expected YYYY-MM-DD).`
      );
    }

    const perModel = costMethod.per_model_cost_breakdown;
    const buckets = costMethod.bucket_breakdown;
    if (!perModel || typeof perModel !== 'object' || Object.keys(perModel).length === 0) {
      errors.push('Missing or empty cost_methodology.per_model_cost_breakdown.');
    } else {
      for (const [modelKey, entry] of Object.entries(perModel)) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          !isNonEmptyString(entry.model) ||
          entry.model !== modelKey ||
          entry.pricing_status === 'unverified' ||
          typeof entry.calls !== 'number' ||
          entry.calls <= 0 ||
          !isFiniteNonNeg(entry.input_tokens) ||
          !isFiniteNonNeg(entry.output_tokens) ||
          !isFiniteNonNeg(entry.reasoning_tokens) ||
          !isFiniteNonNeg(entry.total_tokens) ||
          !isFiniteNonNeg(entry.input_cost_usd) ||
          !isFiniteNonNeg(entry.output_cost_usd) ||
          !isFiniteNonNeg(entry.reasoning_cost_usd) ||
          !isFiniteNonNeg(entry.total_cost_usd) ||
          !isFiniteNonNeg(entry.input_cost_per_million) ||
          !isFiniteNonNeg(entry.output_cost_per_million) ||
          !isFiniteNonNeg(entry.reasoning_cost_per_million) ||
          !isNonEmptyString(entry.pricing_source) ||
          !isNonEmptyString(entry.pricing_last_updated) ||
          entry.cost_estimation_status !== 'estimated_only_not_provider_billed' ||
          entry.provider_billed_cost_reported !== false
        ) {
          errors.push(`Invalid per_model_cost_breakdown entry for model '${modelKey}'.`);
        }
      }
    }

    if (!buckets || typeof buckets !== 'object' || !buckets.baseline || !buckets.ael || !buckets.verifiers) {
      errors.push('Missing cost_methodology.bucket_breakdown (baseline, ael, verifiers).');
    } else {
      for (const bucketName of ['baseline', 'ael', 'verifiers'] as const) {
        const b = buckets[bucketName];
        if (!b || typeof b !== 'object' || !isFiniteNonNeg(b.calls) || !isFiniteNonNeg(b.total_cost_usd) || !b.models) {
          errors.push(`Invalid cost_methodology.bucket_breakdown.${bucketName}.`);
          continue;
        }
        const sumModelCost = Object.values(b.models).reduce((s, m) => s + (m?.total_cost_usd || 0), 0);
        if (Math.abs(sumModelCost - b.total_cost_usd) > 1e-5) {
          errors.push(
            `cost_methodology.bucket_breakdown.${bucketName}.total_cost_usd (${b.total_cost_usd}) disagrees with sum of per-model costs (${sumModelCost}).`
          );
        }
      }

      if (perModel && typeof perModel === 'object' && Object.keys(perModel).length > 0) {
        const totalPerModelCost = Object.values(perModel).reduce((s, m) => s + (m?.total_cost_usd || 0), 0);
        const totalBucketsCost =
          (buckets.baseline.total_cost_usd || 0) +
          (buckets.ael.total_cost_usd || 0) +
          (buckets.verifiers.total_cost_usd || 0);
        if (Math.abs(totalPerModelCost - totalBucketsCost) > 1e-5) {
          errors.push(
            `cost_methodology.per_model_cost_breakdown total cost (${totalPerModelCost}) disagrees with sum of buckets (${totalBucketsCost}).`
          );
        }
      }
    }
  }

  // 5. Verifier results
  const verifiers = data.verifier_results as VerifierResultsSummary | undefined;
  if (
    !verifiers ||
    typeof verifiers.total_verifications !== 'number' ||
    verifiers.total_verifications <= 0 ||
    !isFiniteNonNeg(verifiers.passed) ||
    !isFiniteNonNeg(verifiers.failed) ||
    !isFiniteNonNeg(verifiers.errored)
  ) {
    errors.push('Missing or empty verifier_results.');
  } else {
    if (verifiers.errored > 0) {
      errors.push(`Verifier execution had ${verifiers.errored} error(s); evaluations with errored verifiers cannot pass.`);
    }
    if (verifiers.passed + verifiers.failed + verifiers.errored !== verifiers.total_verifications) {
      errors.push('verifier_results counts do not sum to total_verifications.');
    }
    if (!Array.isArray(verifiers.methods) || verifiers.methods.length === 0) {
      errors.push('verifier_results.methods must list active verification methods.');
    }
  }

  // 6. Token accounting & Suite-specific acceptance checks
  const usage = data.token_usage;
  if (!usage || typeof usage !== 'object' || usage.usage_source !== 'provider_reported') {
    errors.push('Missing provider-reported token_usage accounting.');
  }

  const isToolSuite = String(data.suite_name || '').includes('Tool-DC') || 'selection_cases_total' in data;
  const isBudgetSuite =
    data.benchmark_type === 'comparative_benchmark_identical_samples' || 'overall_baseline_tokens' in data;

  if (!isToolSuite && !isBudgetSuite) {
    errors.push('Unrecognized benchmark suite structure.');
  }

  if (isToolSuite) {
    if (
      !usage ||
      !isFiniteNonNeg(usage.ael_input_tokens) ||
      !isFiniteNonNeg(usage.ael_output_tokens) ||
      !isFiniteNonNeg(usage.ael_reasoning_tokens) ||
      !isFiniteNonNeg(usage.ael_total_tokens) ||
      usage.ael_total_tokens <= 0 ||
      !isFiniteNonNeg(usage.baseline_schema_tokens) ||
      usage.baseline_schema_tokens <= 0
    ) {
      errors.push('Tool suite token_usage missing positive ael_total_tokens or baseline_schema_tokens.');
    }
    const acc = data.accuracy_metrics?.selection_accuracy ?? data.accuracy;
    const catches = data.accuracy_metrics?.dry_run_catches ?? data.dry_run_catches;
    if (typeof acc !== 'number' || acc < BENCHMARK_QUALITY_FLOORS.tool_selection_accuracy) {
      errors.push(
        `Tool selection accuracy ${String(acc)} is below quality floor ${BENCHMARK_QUALITY_FLOORS.tool_selection_accuracy}.`
      );
    }
    if (typeof catches !== 'number' || catches < BENCHMARK_QUALITY_FLOORS.tool_dry_run_catches) {
      errors.push(
        `Dry-run safety catches ${String(catches)} is below required minimum ${BENCHMARK_QUALITY_FLOORS.tool_dry_run_catches}.`
      );
    }
    if (options.requirePassingAcceptance && data.acceptance_status !== 'PASS') {
      errors.push(`Tool benchmark acceptance_status is '${String(data.acceptance_status)}', expected 'PASS'.`);
    }
    if (data.acceptance_status !== 'PASS' && data.savings_claims_valid !== false) {
      errors.push('Failed tool evaluation must set savings_claims_valid=false.');
    }
  }

  if (isBudgetSuite) {
    if (
      !usage ||
      !isFiniteNonNeg(usage.baseline_input_tokens) ||
      !isFiniteNonNeg(usage.baseline_output_tokens) ||
      !isFiniteNonNeg(usage.baseline_reasoning_tokens) ||
      !isFiniteNonNeg(usage.baseline_total_tokens) ||
      usage.baseline_total_tokens <= 0 ||
      !isFiniteNonNeg(usage.ael_input_tokens) ||
      !isFiniteNonNeg(usage.ael_output_tokens) ||
      !isFiniteNonNeg(usage.ael_reasoning_tokens) ||
      !isFiniteNonNeg(usage.ael_total_tokens) ||
      usage.ael_total_tokens <= 0
    ) {
      errors.push('Budget suite token_usage missing positive baseline or AEL token accounting.');
    }

    const metrics = data.accuracy_metrics;
    const baseAcc = metrics?.baseline_accuracy ?? data.baseline_accuracy;
    const aelAcc = metrics?.ael_accuracy ?? data.overall_accuracy;
    if (!metrics || typeof baseAcc !== 'number' || typeof aelAcc !== 'number') {
      errors.push('Missing accuracy_metrics on budget benchmark result.');
    } else {
      if (baseAcc < BENCHMARK_QUALITY_FLOORS.budget_min_baseline_accuracy) {
        errors.push(
          `Baseline accuracy ${baseAcc} is below configured quality floor ${BENCHMARK_QUALITY_FLOORS.budget_min_baseline_accuracy} (zero-on-both-sides cannot pass).`
        );
      }
      if (aelAcc < BENCHMARK_QUALITY_FLOORS.budget_min_ael_accuracy) {
        errors.push(
          `AEL accuracy ${aelAcc} is below configured quality floor ${BENCHMARK_QUALITY_FLOORS.budget_min_ael_accuracy}.`
        );
      }
    }

    if (typeof data.accuracy_drop_pp !== 'number' || data.accuracy_drop_pp > BENCHMARK_QUALITY_FLOORS.budget_max_accuracy_drop_pp) {
      errors.push(
        `Accuracy drop ${String(data.accuracy_drop_pp)} pp exceeds ${BENCHMARK_QUALITY_FLOORS.budget_max_accuracy_drop_pp} pp.`
      );
    }
    if (
      typeof data.overall_p95_overhead_ms !== 'number' ||
      data.overall_p95_overhead_ms >= BENCHMARK_QUALITY_FLOORS.budget_max_p95_overhead_ms
    ) {
      errors.push(
        `p95 overhead ${String(data.overall_p95_overhead_ms)}ms exceeds ${BENCHMARK_QUALITY_FLOORS.budget_max_p95_overhead_ms}ms.`
      );
    }
    if (
      typeof data.overall_token_reduction_pct !== 'number' ||
      data.overall_token_reduction_pct < BENCHMARK_QUALITY_FLOORS.budget_min_token_reduction_pct
    ) {
      errors.push(
        `Overall token reduction ${String(data.overall_token_reduction_pct)}% is below ${BENCHMARK_QUALITY_FLOORS.budget_min_token_reduction_pct}%.`
      );
    }
    if (options.requirePassingAcceptance && data.acceptance_status !== 'PASS') {
      errors.push(`Budget benchmark acceptance_status is '${String(data.acceptance_status)}', expected 'PASS'.`);
    }
    if (
      data.acceptance_status !== 'PASS' &&
      (data.savings_claims_valid !== false ||
        data.overall_net_savings_usd !== null ||
        data.overall_token_reduction_pct !== null)
    ) {
      errors.push('Failed budget evaluation must suppress misleading headline savings claims.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function assertValidBenchmarkResult(data: any): void {
  const validation = validateBenchmarkResult(data, { requirePassingAcceptance: true });
  if (!validation.valid) {
    throw new Error(`[AEL Benchmark Acceptance REJECTED]\n- ${validation.errors.join('\n- ')}`);
  }
}
