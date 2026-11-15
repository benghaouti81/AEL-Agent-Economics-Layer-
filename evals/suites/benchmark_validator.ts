/**
 * AEL — Benchmark Evidence Provenance & Acceptance Validator
 * Enforces strict evidence integrity rules:
 * - Only "live_provider" source accepted (never legacy simulator or "unit_test")
 * - Full provider, model, credential status, dataset hash, token accounting, verifier, and cost methodology required
 * - Rejects zero-valid-sample evaluations, failed verifiers, and below-floor accuracy (including 0/N vs 0/N)
 * - Prohibits failed evaluations from emitting misleading savings claims
 * @license Apache-2.0
 */

import crypto from 'node:crypto';

export type BenchmarkSource = 'live_provider' | 'unit_test';

export const ALLOWED_LIVE_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;

export const BENCHMARK_QUALITY_FLOORS = {
  tool_selection_accuracy: 0.90,
  tool_dry_run_catches: 3,
  budget_min_token_reduction_pct: 50.0,
  budget_max_accuracy_drop_pp: 2.0,
  budget_max_p95_overhead_ms: 500,
  budget_min_baseline_accuracy: 0.50,
  budget_min_ael_accuracy: 0.50,
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
  provider_billed_cost_reported: boolean;
  usage_source: 'provider_reported';
  currency: 'USD';
  input_cost_per_million: number;
  output_cost_per_million: number;
  reasoning_cost_per_million: number;
  verification_cost_excluded_from_product_savings: boolean;
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

export function computeDatasetHash(canonicalCases: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalCases)).digest('hex');
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

export function validateBenchmarkResult(
  data: any,
  options: { requirePassingAcceptance?: boolean } = { requirePassingAcceptance: true }
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

  // 3. Split, dataset version/hash, timestamp, valid sample count
  if (!isNonEmptyString(data.split)) {
    errors.push('Missing benchmark split.');
  }
  if (!isNonEmptyString(data.dataset_version)) {
    errors.push('Missing dataset_version.');
  }
  if (!isNonEmptyString(data.dataset_hash) || !/^[a-f0-9]{64}$/i.test(data.dataset_hash)) {
    errors.push('Missing or invalid SHA-256 dataset_hash.');
  }
  if (!isNonEmptyString(data.timestamp) || Number.isNaN(Date.parse(data.timestamp))) {
    errors.push(`Invalid or missing evaluation timestamp: '${String(data.timestamp)}'.`);
  }
  const validSamples = data.sample_size?.valid_samples;
  if (typeof validSamples !== 'number' || !Number.isInteger(validSamples) || validSamples <= 0) {
    errors.push(`Zero-valid-sample evaluations cannot be accepted (valid_samples=${String(validSamples)}).`);
  }

  // 4. Cost accounting methodology
  const costMethod = data.cost_methodology as CostMethodology | undefined;
  if (
    !costMethod ||
    !['estimated_from_provider_usage_and_profile_rates', 'provider_billed'].includes(costMethod.billing_basis) ||
    typeof costMethod.provider_billed_cost_reported !== 'boolean' ||
    costMethod.usage_source !== 'provider_reported' ||
    costMethod.currency !== 'USD'
  ) {
    errors.push('Missing or invalid cost_methodology metadata.');
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
