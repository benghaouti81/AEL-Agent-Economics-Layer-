/**
 * AEL — Agent Economics Layer
 * Thinking Budget Engine (AERA arXiv:2608.27964, CoBa arXiv:2608.07424)
 * Adaptive test-time compute allocation across Single, Sample, and Search regimes
 * @license Apache-2.0
 */

import crypto from 'node:crypto';
import { LLMClient, LLMResponse } from '../llm/client.js';
import { DecisionLogStore } from '../db/decision_log.js';
import { CircuitBreakerController } from './circuit_breaker.js';
import { PresetPolicy } from '../config/ael_config.js';
import { ConfidenceLevel, ScalingRegime } from '../models/contracts.js';

export interface BudgetRoutingResult {
  text: string;
  regime: ScalingRegime;
  final_effort: 'none' | 'low' | 'medium' | 'high';
  escalated: boolean;
  escalation_levels: number;
  confidence_signal: ConfidenceLevel;
  samples_generated: number;
  total_tokens: number;
  upstream_tokens: number;
  ael_internal_tokens: number;
  net_tokens_saved: number;
  total_cost_usd: number;
  net_cost_saved_usd: number;
  baseline_tokens: number;
  baseline_cost_usd: number;
  baseline_source: 'measured_reference' | 'assumed_baseline';
  assumed_baseline?: {
    total_tokens: number;
    cost_usd: number;
    basis: string;
  };
  latency_ms: number;
  ael_overhead_ms: number;
  circuit_breaker_tripped: boolean;
  pass_through: boolean;
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
      reference_baseline?: { total_tokens: number; cost_usd: number };
      assumed_baseline?: { total_tokens: number; cost_usd: number; basis?: string };
      measure_baseline?: boolean;
    } = {}
  ): Promise<BudgetRoutingResult> {
    const startTime = Date.now();
    const workflow_id = options.workflow_id || 'default_workflow';
    const task_category = options.task_category || 'general';
    const policy = options.policy || this.defaultPolicy;
    const query_hash = crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);

    // Check Circuit Breaker (using unfloored historical savings)
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
        options.reference_baseline
      );
    }

    // Obtain baseline either from pre-measured reference, live reference call, or explicit assumed_baseline
    let baselineTotalTokens: number;
    let baselineCostUsd: number;
    let baselineSource: 'measured_reference' | 'assumed_baseline';
    let assumedBaselineDetail: { total_tokens: number; cost_usd: number; basis: string } | undefined;

    if (options.reference_baseline) {
      baselineTotalTokens = options.reference_baseline.total_tokens;
      baselineCostUsd = options.reference_baseline.cost_usd;
      baselineSource = 'measured_reference';
    } else if (options.assumed_baseline) {
      baselineTotalTokens = options.assumed_baseline.total_tokens;
      baselineCostUsd = options.assumed_baseline.cost_usd;
      baselineSource = 'assumed_baseline';
      assumedBaselineDetail = {
        total_tokens: baselineTotalTokens,
        cost_usd: baselineCostUsd,
        basis: options.assumed_baseline.basis || 'caller_supplied_assumed_baseline',
      };
    } else if (options.measure_baseline !== false) {
      // Measure reference consumption directly by running the same task at fixed high reasoning effort
      const refRes = await this.llm.complete(prompt, { reasoning_effort: 'high' });
      baselineTotalTokens = refRes.total_tokens;
      baselineCostUsd = refRes.cost_usd;
      baselineSource = 'measured_reference';
    } else {
      // Defer to executed probe / actual consumption as an explicitly labeled assumed_baseline (zero fabricated constants)
      baselineTotalTokens = 0;
      baselineCostUsd = 0;
      baselineSource = 'assumed_baseline';
    }

    let aelInternalTokens = 0;
    let aelInternalCost = 0;
    let upstreamTokens = 0;
    let upstreamCost = 0;

    // STEP 1: CHEAP FIRST PROBE (Lowest inference budget)
    const initialEffort = policy.initial_reasoning_effort;
    const probeResponse = await this.llm.complete(prompt, { reasoning_effort: initialEffort });

    upstreamTokens += probeResponse.total_tokens;
    upstreamCost += probeResponse.cost_usd;

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
      for (let i = 1; i < k; i++) {
        const sampleRes = await this.llm.complete(prompt, {
          reasoning_effort: initialEffort,
          temperature: 0.7,
        });
        samplesCount++;
        upstreamTokens += sampleRes.total_tokens;
        upstreamCost += sampleRes.cost_usd;
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

      const judgeRes = await this.llm.complete(judgePrompt, { reasoning_effort: finalEffort });

      const judgePostStart = performance.now();
      aelInternalTokens += judgeRes.total_tokens;
      aelInternalCost += judgeRes.cost_usd;

      finalResponse = judgeRes;
      confidenceSignal = 'model_confidence'; // Evaluated and resolved by LLM judge step
      aelOverheadMs += performance.now() - judgePostStart;
    }

    const totalLatency = Date.now() - startTime;
    const finalAelOverheadMs = Math.max(0, Math.round(aelOverheadMs));

    const actualTotalTokens = upstreamTokens + aelInternalTokens;
    const actualTotalCost = upstreamCost + aelInternalCost;

    // Finalize explicitly labeled assumed_baseline when measure_baseline=false and no baseline supplied
    if (baselineSource === 'assumed_baseline' && !assumedBaselineDetail) {
      baselineTotalTokens = probeResponse.total_tokens;
      baselineCostUsd = probeResponse.cost_usd;
      assumedBaselineDetail = {
        total_tokens: baselineTotalTokens,
        cost_usd: baselineCostUsd,
        basis: 'initial_probe_unescalated_reference',
      };
    }

    // NET SAVINGS ACCOUNTING (UNFLOORED so losses are visible and consumed by CircuitBreaker):
    // Net Savings = Baseline - (Upstream + AEL Internal)
    const netTokensSaved = baselineTotalTokens - actualTotalTokens;
    const netCostSavedUsd = Number((baselineCostUsd - actualTotalCost).toFixed(6));

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
      regime: policy.regime,
      final_effort: finalEffort,
      escalated: shouldEscalate,
      escalation_levels: escalationLevels,
      confidence_signal: confidenceSignal,
      samples_generated: samplesCount,
      total_tokens: actualTotalTokens,
      upstream_tokens: upstreamTokens,
      ael_internal_tokens: aelInternalTokens,
      net_tokens_saved: netTokensSaved,
      total_cost_usd: actualTotalCost,
      net_cost_saved_usd: netCostSavedUsd,
      baseline_tokens: baselineTotalTokens,
      baseline_cost_usd: baselineCostUsd,
      baseline_source: baselineSource,
      ...(assumedBaselineDetail ? { assumed_baseline: assumedBaselineDetail } : {}),
      latency_ms: totalLatency,
      ael_overhead_ms: finalAelOverheadMs,
      circuit_breaker_tripped: breakerStatus.tripped,
      pass_through: false,
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
    referenceBaseline?: { total_tokens: number; cost_usd: number }
  ): Promise<BudgetRoutingResult> {
    // Pass-through: uses baseline high effort directly; reference baseline equals the execution itself if none supplied
    const response = await this.llm.complete(prompt, { reasoning_effort: 'high' });
    const latency_ms = Date.now() - startTime;
    const baselineTotalTokens = referenceBaseline ? referenceBaseline.total_tokens : response.total_tokens;
    const baselineCostUsd = referenceBaseline ? referenceBaseline.cost_usd : response.cost_usd;
    const netTokensSaved = baselineTotalTokens - response.total_tokens;
    const netCostSavedUsd = Number((baselineCostUsd - response.cost_usd).toFixed(6));

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
      regime: 'single',
      final_effort: 'high',
      escalated: false,
      escalation_levels: 0,
      confidence_signal: 'insufficient_evidence',
      samples_generated: 1,
      total_tokens: response.total_tokens,
      upstream_tokens: response.total_tokens,
      ael_internal_tokens: 0,
      net_tokens_saved: netTokensSaved,
      total_cost_usd: response.cost_usd,
      net_cost_saved_usd: netCostSavedUsd,
      baseline_tokens: baselineTotalTokens,
      baseline_cost_usd: baselineCostUsd,
      baseline_source: 'measured_reference',
      latency_ms,
      ael_overhead_ms: 1,
      circuit_breaker_tripped: circuitBreakerTripped,
      pass_through: true,
    };
  }
}
