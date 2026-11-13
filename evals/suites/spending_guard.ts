/**
 * AEL — Live Evaluation Spending Guard & Credential Validator
 * Prevents runaway API spend on live evaluation suites (STEERING.md §4 C-2: abort if projected cost > $1).
 * @license Apache-2.0
 */

import { ProviderProfile } from '../../src/config/ael_config.js';

export const MAX_LIVE_EVAL_COST_USD = 1.0;

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
  if (!key || key === 'MY_GEMINI_API_KEY' || key === 'YOUR_API_KEY') {
    throw new Error(
      '[AEL Live Eval] GEMINI_API_KEY is missing or set to a placeholder. Live evaluation requires a real GEMINI_API_KEY and never falls back to mock.'
    );
  }
  return key;
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

  // Documented token approximation: ~4 chars per token (consistent with ToolDCEngine & LLMClient)
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
