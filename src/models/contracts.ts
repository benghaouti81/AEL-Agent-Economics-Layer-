/**
 * AEL — Agent Economics Layer
 * Data Contracts & Schemas (Zod)
 * @license Apache-2.0
 */

import { z } from 'zod';
import crypto from 'node:crypto';

// ==========================================
// 1. Author-Declared Tool Execution Contracts
// ==========================================
export const DryRunSupportSchema = z.enum(['real', 'simulated', 'none']);
export type DryRunSupport = z.infer<typeof DryRunSupportSchema>;

export const SideEffectSchema = z.enum(['none', 'idempotent', 'mutating']);
export type SideEffect = z.infer<typeof SideEffectSchema>;

export const ToolRecordSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.any()), // JSON Schema
  server: z.string().default('default'),
  // Author-Declared Execution Contract (NEVER inferred by LLM)
  dry_run_support: DryRunSupportSchema,
  side_effect: SideEffectSchema,
  reversible: z.boolean().default(false),
  reversal_tool_ref: z.string().optional(),
  requires_human_approval: z.boolean().default(false),
  idempotency_key: z.string().optional(),
});
export type ToolRecord = z.infer<typeof ToolRecordSchema>;
export type ToolRecordInput = z.input<typeof ToolRecordSchema>;

// ==========================================
// 2. Confidence Signal Taxonomy (6 Signals)
// ==========================================
export const ConfidenceLevelSchema = z.enum([
  'externally_verified',   // Deterministic non-LLM check, dry-run sandbox outcome, or deterministic tool validation
  'model_confidence',      // Provider-reported logprobs or token confidence metrics only (never LLM judge)
  'llm_judge_verdict',     // Explicit LLM-Judge escalation/verification verdict
  'consensus',             // Agreement among k samples in sample mode (stopping heuristic, NOT proof of correctness)
  'insufficient_evidence', // Escalation trigger, pass-through, or policy halt
  'unavailable',           // No confidence signal available (single probe without provider logprobs or consensus check)
]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

// ==========================================
// 3. Test-Time Scaling Regimes (arXiv:2608.04001)
// ==========================================
export const ScalingRegimeSchema = z.enum(['single', 'sample', 'search']);
export type ScalingRegime = z.infer<typeof ScalingRegimeSchema>;

// ==========================================
// 4. Decision Log Record (Net Savings Accounting)
// ==========================================
export const DecisionRecordSchema = z.object({
  id: z.string().default(() => crypto.randomUUID()),
  timestamp: z.number().default(() => Date.now()),
  workflow_id: z.string(), // Hashed or anonymized unless log_payloads=true
  session_id: z.string().optional(),
  query_hash: z.string(),
  task_category: z.string().default('general'), // factual, math, code, extraction
  schema_hash: z.string(), // Active toolset hash
  
  // Tool Selection Metrics (Tool-DC)
  tool_chosen: z.string().nullable().default(null),
  tool_args_hash: z.string().nullable().default(null),
  retries_count: z.number().default(0),
  dry_run_executed: z.boolean().default(false),
  dry_run_passed: z.boolean().nullable().default(null),
  dry_run_caught_error: z.string().nullable().default(null),
  human_approval_granted: z.boolean().default(false),
  
  // Thinking Budget Metrics (AERA & CoBa)
  regime: ScalingRegimeSchema.default('single'),
  reasoning_effort: z.string().default('low'),
  escalated: z.boolean().default(false),
  escalation_levels: z.number().default(0),
  confidence_signal: ConfidenceLevelSchema.default('insufficient_evidence'),
  samples_count: z.number().default(1),
  
  // Detailed Token Accounting
  baseline_tokens: z.number().default(0),
  upstream_tokens: z.number().default(0),
  ael_internal_tokens: z.number().default(0), // Overhead: selection batches, judges, probes
  net_tokens_saved: z.number().default(0),
  
  // Detailed USD Cost Accounting (Net Savings)
  // net_cost_saved_usd = baseline_cost_usd - (upstream_cost_usd + ael_internal_cost_usd)
  baseline_cost_usd: z.number().default(0),
  upstream_cost_usd: z.number().default(0),
  ael_internal_cost_usd: z.number().default(0),
  net_cost_saved_usd: z.number().default(0),
  
  // Latency & Execution Outcomes
  latency_ms: z.number().default(0),
  ael_overhead_ms: z.number().default(0),
  completed_successfully: z.boolean().default(true),
  circuit_breaker_tripped: z.boolean().default(false),
  pass_through: z.boolean().default(false),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

// Summary Metrics for Dashboard & CLI
export const MetricsSummarySchema = z.object({
  total_requests: z.number(),
  successful_tasks: z.number(),
  total_baseline_tokens: z.number(),
  total_actual_tokens: z.number(), // upstream + ael internal
  total_net_tokens_saved: z.number(),
  percent_tokens_saved: z.number(),
  
  total_baseline_cost_usd: z.number(),
  total_actual_cost_usd: z.number(),
  total_net_cost_saved_usd: z.number(),
  percent_cost_saved: z.number(),
  
  // Headline KPI
  usd_per_completed_task_baseline: z.number(),
  usd_per_completed_task_ael: z.number(),
  
  tool_selection_accuracy: z.number(),
  dry_run_catches_count: z.number(),
  average_retries: z.number(),
  
  p50_latency_ms: z.number(),
  p95_latency_ms: z.number(),
  p95_ael_overhead_ms: z.number(),
  
  escalation_distribution: z.record(z.string(), z.number()),
  confidence_distribution: z.record(z.string(), z.number()),
  circuit_breaker_tripped_workflows: z.array(z.string()),
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;
