/**
 * AEL — Agent Economics Layer
 * Thinking Budget Engine (AERA arXiv:2608.27964, CoBa arXiv:2608.07424)
 * Adaptive test-time compute allocation across Single, Sample, and Search regimes
 * @license Apache-2.0
 */

import crypto from 'node:crypto';
import { CallRole, CallUsageRecord, LLMClient, LLMResponse } from '../llm/client.js';
import { DecisionLogStore } from '../db/decision_log.js';
import { CircuitBreakerController } from './circuit_breaker.js';
import { PresetPolicy } from '../config/ael_config.js';
import { ConfidenceLevel, ScalingRegime } from '../models/contracts.js';

export interface BudgetRoutingResult {
  text: string;
  accounting_mode: 'actual_only' | 'comparative_benchmark';
  regime: ScalingRegime;
  final_effort: 'none' | 'low' | 'medium' | 'high';
  escalated: boolean;
  escalation_levels: number;
  confidence_signal: ConfidenceLevel;
  samples_generated: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  upstream_tokens: number;
  ael_internal_tokens: number;
  net_tokens_saved: number;
  total_cost_usd: number;
  net_cost_saved_usd: number;
  baseline_tokens: number;
  baseline_cost_usd: number;
  baseline_source: 'none_actual_only' | 'comparative_benchmark';
  latency_ms: number;
  ael_overhead_ms: number;
  circuit_breaker_tripped: boolean;
  pass_through: boolean;
  provider_source: LLMResponse['provider_source'];
  model: string;
  usage_source: LLMResponse['usage_source'];
  calls: CallUsageRecord[];
}

export class BudgetEngine {
  constructor(
    private llm: LLMClient,
    private logStore: DecisionLogStore,
    private circuitBreaker: CircuitBreakerController,
    private defaultPolicy: PresetPolicy
  ) {}

  public async routeAndExecute(
    prompt: string,
    options: {
      workflow_id?: string;
      session_id?: string;
      task_category?: string;
      policy?: PresetPolicy;
      pass_through?: boolean;
      use_profile_model_tiers?: boolean;
      models?: {
        probe_model?: string;
        sample_model?: string;
        judge_model?: string;
        pass_through_model?: string;
      };
      reference_baseline?: { total_tokens: number; cost_usd: number };
    } = {}
  ): Promise<BudgetRoutingResult> {
    const startTime = Date.now();
    const workflow_id = options.workflow_id || 'default_workflow';
    const task_category = options.task_category || 'general';
    const policy = options.policy || this.defaultPolicy;
    const query_hash = crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);
    const profile = this.llm.getProfile();

    // Check Circuit Breaker (using unfloored historical comparative savings & error rate)
    const breakerStatus = this.circuitBreaker.isTripped(workflow_id);
    const passThrough = options.pass_through || breakerStatus.tripped;

    if (passThrough) {
      return this.executePassThrough(
        prompt,
        workflow_id,
        options.session_id,
        query_hash,
        task_category,
        startTime,
        breakerStatus.tripped,
        options.reference_baseline,
        options.models?.pass_through_model ?? (options.use_profile_model_tiers ? profile.default_model : undefined)
      );
    }

    // Live per-request accounting reports ACTUAL consumption only (never counterfactual savings).
    // Comparative savings are computed ONLY when a comparative benchmark supplies reference_baseline
    // measured on identical samples.
    const hasComparativeBaseline = options.reference_baseline !== undefined;
    const accountingMode: 'actual_only' | 'comparative_benchmark' = hasComparativeBaseline
      ? 'comparative_benchmark'
      : 'actual_only';
    const baselineSource: 'none_actual_only' | 'comparative_benchmark' = hasComparativeBaseline
      ? 'comparative_benchmark'
      : 'none_actual_only';
    const baselineTotalTokens = hasComparativeBaseline ? options.reference_baseline!.total_tokens : 0;
    const baselineCostUsd = hasComparativeBaseline ? options.reference_baseline!.cost_usd : 0;

    let aelInternalTokens = 0;
    let aelInternalCost = 0;
    let upstreamTokens = 0;
    let upstreamCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    const calls: CallUsageRecord[] = [];

    const toCallRecord = (role: CallRole, requestedModel: string, res: LLMResponse): CallUsageRecord => ({
      role,
      requested_model: res.requested_model || requestedModel,
      model: res.model,
      input_tokens: res.input_tokens,
      output_tokens: res.output_tokens,
      reasoning_tokens: res.reasoning_tokens,
      total_tokens: res.total_tokens,
      input_cost_usd: res.input_cost_usd,
      output_cost_usd: res.output_cost_usd,
      reasoning_cost_usd: res.reasoning_cost_usd,
      cost_usd: res.cost_usd,
      billing_basis: 'estimated_from_provider_usage_and_profile_rates',
      cost_estimation_status: 'estimated_only_not_provider_billed',
      provider_billed_cost_reported: false,
      provider_source: res.provider_source,
      usage_source: res.usage_source,
    });

    // STEP 1: CHEAP FIRST PROBE (Lowest inference budget)
    const initialEffort = policy.initial_reasoning_effort;
    const probeModel =
      options.models?.probe_model ?? (options.use_profile_model_tiers ? profile.cheap_model : undefined);
    const probeResponse = await this.llm.complete(prompt, {
      ...(probeModel ? { model: probeModel } : {}),
      reasoning_effort: initialEffort,
    });

    calls.push(toCallRecord('ael_probe', probeModel || profile.default_model, probeResponse));
    upstreamTokens += probeResponse.total_tokens;
    upstreamCost = Number((upstreamCost + probeResponse.cost_usd).toFixed(6));
    totalInputTokens += probeResponse.input_tokens;
    totalOutputTokens += probeResponse.output_tokens;
    totalReasoningTokens += probeResponse.reasoning_tokens;

    // Initialize cumulative AEL decision overhead time (ms)
    let aelOverheadMs = 0;

    // STEP 2: EVIDENCE RESIDUAL CHECK (CoBa & AERA controller)
    const decisionStep1Start = performance.now();
    let confidenceSignal: ConfidenceLevel = 'insufficient_evidence';
    let shouldEscalate = false;
    let escalationLevels = 0;
    let samplesCount = 1;
    let finalEffort = initialEffort;
    let candidateAnswers = [probeResponse.text];

    // Evaluate difficulty heuristic based on task class & prompt features
    const isComplex = this.assessComplexityHeuristic(prompt, task_category);

    if (policy.regime === 'sample') {
      // REGIME: SAMPLE (Self-Consistency Consensus Probe across k samples)
      aelOverheadMs += performance.now() - decisionStep1Start;
      const k = Math.min(policy.k_samples, 3);
      const sampleModel =
        options.models?.sample_model ?? (options.use_profile_model_tiers ? profile.default_model : undefined);
      for (let i = 1; i < k; i++) {
        const sampleRes = await this.llm.complete(prompt, {
          ...(sampleModel ? { model: sampleModel } : {}),
          reasoning_effort: initialEffort,
          temperature: 0.7,
        });
        samplesCount++;
        calls.push(toCallRecord('ael_sample', sampleModel || profile.default_model, sampleRes));
        upstreamTokens += sampleRes.total_tokens;
        upstreamCost = Number((upstreamCost + sampleRes.cost_usd).toFixed(6));
        totalInputTokens += sampleRes.input_tokens;
        totalOutputTokens += sampleRes.output_tokens;
        totalReasoningTokens += sampleRes.reasoning_tokens;
        candidateAnswers.push(sampleRes.text);
      }

      const consensusStart = performance.now();
      // Check consensus among samples
      const consensusAgreement = this.calculateConsensus(candidateAnswers);
      if (consensusAgreement >= policy.evidence_confidence_threshold) {
        // Consensus achieved — NOTE: consensus is a stopping heuristic, NEVER labeled "verified"
        confidenceSignal = 'consensus';
        shouldEscalate = false;
      } else {
        confidenceSignal = 'insufficient_evidence';
        shouldEscalate = true;
      }
      aelOverheadMs += performance.now() - consensusStart;
    } else {
      // REGIME: SINGLE (Trajectory confidence probe with complexity escalation)
      if (isComplex && policy.effort_ladder.length > 1) {
        // High-difficulty task demands compute escalation beyond cheap probe
        confidenceSignal = 'insufficient_evidence';
        shouldEscalate = true;
      } else if (probeResponse.logprob_confidence !== undefined && probeResponse.logprob_confidence >= policy.evidence_confidence_threshold) {
        confidenceSignal = 'model_confidence';
        shouldEscalate = false;
      } else {
        confidenceSignal = 'unavailable';
        shouldEscalate = false;
      }
      aelOverheadMs += performance.now() - decisionStep1Start;
    }

    // STEP 3: ESCALATE OR STOP
    let finalResponse = probeResponse;

    if (shouldEscalate) {
      const escalateDecisionStart = performance.now();
      // Escalate to next reasoning effort tier
      const currentEffortIndex = policy.effort_ladder.indexOf(initialEffort);
      const nextEffortIndex = Math.min(policy.effort_ladder.length - 1, Math.max(0, currentEffortIndex + 1));
      finalEffort = policy.effort_ladder[nextEffortIndex];
      escalationLevels = 1;

      // Judge step (AEL internal verifier compute)
      const judgePrompt = `EVALUATE EVIDENCE AND RESOLVE QUERY:\nTask: ${prompt}\nPreliminary Candidates:\n${candidateAnswers.join('\n---\n')}`;
      aelOverheadMs += performance.now() - escalateDecisionStart;

      const judgeModel =
        options.models?.judge_model ?? (options.use_profile_model_tiers ? profile.reasoning_model : undefined);
      const judgeRes = await this.llm.complete(judgePrompt, {
        ...(judgeModel ? { model: judgeModel } : {}),
        reasoning_effort: finalEffort,
      });

      const judgePostStart = performance.now();
      calls.push(toCallRecord('ael_judge', judgeModel || profile.default_model, judgeRes));
      aelInternalTokens += judgeRes.total_tokens;
      aelInternalCost = Number((aelInternalCost + judgeRes.cost_usd).toFixed(6));
      totalInputTokens += judgeRes.input_tokens;
      totalOutputTokens += judgeRes.output_tokens;
      totalReasoningTokens += judgeRes.reasoning_tokens;

      finalResponse = judgeRes;
      confidenceSignal = 'llm_judge_verdict'; // Evaluated and resolved by LLM judge step (distinct from provider logprobs)
      aelOverheadMs += performance.now() - judgePostStart;
    }

    const totalLatency = Date.now() - startTime;
    const finalAelOverheadMs = Math.max(0, Math.round(aelOverheadMs));

    const actualTotalTokens = upstreamTokens + aelInternalTokens;
    const actualTotalCost = Number(calls.reduce((sum, c) => sum + c.cost_usd, 0).toFixed(6));

    // Comparative net savings are computed ONLY in comparative_benchmark mode (never counterfactual per-request).
    // In actual_only live mode, baseline and savings are zero and actual consumption is logged.
    const netTokensSaved = hasComparativeBaseline ? baselineTotalTokens - actualTotalTokens : 0;
    const netCostSavedUsd = hasComparativeBaseline ? Number((baselineCostUsd - actualTotalCost).toFixed(6)) : 0;

    // Write to SQLite Decision Log
    this.logStore.insertDecision({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      workflow_id,
      session_id: options.session_id,
      query_hash,
      task_category,
      schema_hash: 'n/a',
      tool_chosen: null,
      tool_args_hash: null,
      retries_count: 0,
      dry_run_executed: false,
      dry_run_passed: null,
      dry_run_caught_error: null,
      human_approval_granted: false,
      regime: policy.regime,
      reasoning_effort: finalEffort,
      escalated: shouldEscalate,
      escalation_levels: escalationLevels,
      confidence_signal: confidenceSignal,
      samples_count: samplesCount,
      baseline_tokens: baselineTotalTokens,
      upstream_tokens: upstreamTokens,
      ael_internal_tokens: aelInternalTokens,
      net_tokens_saved: netTokensSaved,
      baseline_cost_usd: baselineCostUsd,
      upstream_cost_usd: upstreamCost,
      ael_internal_cost_usd: aelInternalCost,
      net_cost_saved_usd: netCostSavedUsd,
      latency_ms: totalLatency,
      ael_overhead_ms: finalAelOverheadMs,
      completed_successfully: true,
      circuit_breaker_tripped: breakerStatus.tripped,
      pass_through: false,
    });

    return {
      text: finalResponse.text,
      accounting_mode: accountingMode,
      regime: policy.regime,
      final_effort: finalEffort,
      escalated: shouldEscalate,
      escalation_levels: escalationLevels,
      confidence_signal: confidenceSignal,
      samples_generated: samplesCount,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      reasoning_tokens: totalReasoningTokens,
      total_tokens: actualTotalTokens,
      upstream_tokens: upstreamTokens,
      ael_internal_tokens: aelInternalTokens,
      net_tokens_saved: netTokensSaved,
      total_cost_usd: actualTotalCost,
      net_cost_saved_usd: netCostSavedUsd,
      baseline_tokens: baselineTotalTokens,
      baseline_cost_usd: baselineCostUsd,
      baseline_source: baselineSource,
      latency_ms: totalLatency,
      ael_overhead_ms: finalAelOverheadMs,
      circuit_breaker_tripped: breakerStatus.tripped,
      pass_through: false,
      provider_source: finalResponse.provider_source,
      model: finalResponse.model,
      usage_source: finalResponse.usage_source,
      calls,
    };
  }

  private assessComplexityHeuristic(prompt: string, category: string): boolean {
    if (category === 'math' || category === 'code') return true;
    if (prompt.length > 250) return true;
    const mathCodeKeywords = ['calculate', 'prove', 'optimize', 'debug', 'algorithm', 'differential', 'formula'];
    return mathCodeKeywords.some(k => prompt.toLowerCase().includes(k));
  }

  private calculateConsensus(answers: string[]): number {
    if (answers.length <= 1) return 1.0;
    // Normalized string similarity / key token overlap
    const tokens = answers.map(a => new Set(a.toLowerCase().split(/\s+/)));
    let matchCount = 0;
    for (let i = 0; i < answers.length; i++) {
      for (let j = i + 1; j < answers.length; j++) {
        const intersection = Array.from(tokens[i]).filter(x => tokens[j].has(x));
        const union = new Set([...tokens[i], ...tokens[j]]);
        const jaccard = union.size > 0 ? intersection.length / union.size : 1.0;
        if (jaccard >= 0.5) matchCount++;
      }
    }
    const pairs = (answers.length * (answers.length - 1)) / 2;
    return pairs > 0 ? matchCount / pairs : 1.0;
  }

  private async executePassThrough(
    prompt: string,
    workflow_id: string,
    session_id: string | undefined,
    query_hash: string,
    task_category: string,
    startTime: number,
    circuitBreakerTripped: boolean,
    referenceBaseline?: { total_tokens: number; cost_usd: number },
    requestedModel?: string
  ): Promise<BudgetRoutingResult> {
    // Pass-through: uses baseline high effort directly; live requests report actual consumption only
    const response = await this.llm.complete(prompt, {
      ...(requestedModel ? { model: requestedModel } : {}),
      reasoning_effort: 'high',
    });
    const latency_ms = Date.now() - startTime;
    const hasRef = referenceBaseline !== undefined;
    const baselineTotalTokens = hasRef ? referenceBaseline!.total_tokens : 0;
    const baselineCostUsd = hasRef ? referenceBaseline!.cost_usd : 0;
    const netTokensSaved = hasRef ? baselineTotalTokens - response.total_tokens : 0;
    const netCostSavedUsd = hasRef ? Number((baselineCostUsd - response.cost_usd).toFixed(6)) : 0;
    const passCall: CallUsageRecord = {
      role: 'ael_passthrough',
      requested_model: response.requested_model || requestedModel || this.llm.getProfile().default_model,
      model: response.model,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      reasoning_tokens: response.reasoning_tokens,
      total_tokens: response.total_tokens,
      input_cost_usd: response.input_cost_usd,
      output_cost_usd: response.output_cost_usd,
      reasoning_cost_usd: response.reasoning_cost_usd,
      cost_usd: response.cost_usd,
      billing_basis: 'estimated_from_provider_usage_and_profile_rates',
      cost_estimation_status: 'estimated_only_not_provider_billed',
      provider_billed_cost_reported: false,
      provider_source: response.provider_source,
      usage_source: response.usage_source,
    };

    this.logStore.insertDecision({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      workflow_id,
      session_id,
      query_hash,
      task_category,
      schema_hash: 'n/a',
      tool_chosen: null,
      tool_args_hash: null,
      retries_count: 0,
      dry_run_executed: false,
      dry_run_passed: null,
      dry_run_caught_error: null,
      human_approval_granted: false,
      regime: 'single',
      reasoning_effort: 'high',
      escalated: false,
      escalation_levels: 0,
      confidence_signal: 'insufficient_evidence',
      samples_count: 1,
      baseline_tokens: baselineTotalTokens,
      upstream_tokens: response.total_tokens,
      ael_internal_tokens: 0,
      net_tokens_saved: netTokensSaved,
      baseline_cost_usd: baselineCostUsd,
      upstream_cost_usd: response.cost_usd,
      ael_internal_cost_usd: 0,
      net_cost_saved_usd: netCostSavedUsd,
      latency_ms,
      ael_overhead_ms: 1,
      completed_successfully: true,
      circuit_breaker_tripped: circuitBreakerTripped,
      pass_through: true,
    });

    return {
      text: response.text,
      accounting_mode: hasRef ? 'comparative_benchmark' : 'actual_only',
      regime: 'single',
      final_effort: 'high',
      escalated: false,
      escalation_levels: 0,
      confidence_signal: 'insufficient_evidence',
      samples_generated: 1,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      reasoning_tokens: response.reasoning_tokens,
      total_tokens: response.total_tokens,
      upstream_tokens: response.total_tokens,
      ael_internal_tokens: 0,
      net_tokens_saved: netTokensSaved,
      total_cost_usd: response.cost_usd,
      net_cost_saved_usd: netCostSavedUsd,
      baseline_tokens: baselineTotalTokens,
      baseline_cost_usd: baselineCostUsd,
      baseline_source: hasRef ? 'comparative_benchmark' : 'none_actual_only',
      latency_ms,
      ael_overhead_ms: 1,
      circuit_breaker_tripped: circuitBreakerTripped,
      pass_through: true,
      provider_source: response.provider_source,
      model: response.model,
      usage_source: response.usage_source,
      calls: [passCall],
    };
  }
}
