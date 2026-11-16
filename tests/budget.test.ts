/**
 * Unit Tests: Thinking Budget Engine & Circuit Breaker
 * Uses an isolated unit-test LLM double (never generates benchmark reports or performance evidence).
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetEngine } from '../src/engines/budget.js';
import { CircuitBreakerController } from '../src/engines/circuit_breaker.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { DEFAULT_PRESETS } from '../src/config/ael_config.js';
import { createUnitTestLLMClient } from './helpers/test_llm_double.js';

describe('Budget Engine & Circuit Breaker', () => {
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let circuitBreaker: CircuitBreakerController;
  let engine: BudgetEngine;

  beforeEach(() => {
    logStore = new DecisionLogStore(':memory:');
    llm = createUnitTestLLMClient({ supports_logprobs: true });
    circuitBreaker = new CircuitBreakerController(
      { enabled: true, rolling_window: 5, min_net_savings_usd: 0, max_error_rate: 0.2 },
      logStore
    );
    engine = new BudgetEngine(llm, logStore, circuitBreaker, DEFAULT_PRESETS.balanced);
  });

  it('allocates cheap compute for simple queries and reports actual-only consumption without counterfactual savings (P0-15)', async () => {
    let callCount = 0;
    const origComplete = llm.complete.bind(llm);
    llm.complete = async (prompt, options) => {
      callCount++;
      return origComplete(prompt, options);
    };

    const res = await engine.routeAndExecute('What is 2 + 2?', { task_category: 'factual' });
    expect(callCount).toBe(1); // Must NOT run a hidden counterfactual baseline call on live requests
    expect(res.final_effort).toBe('low');
    expect(res.escalated).toBe(false);
    expect(res.accounting_mode).toBe('actual_only');
    expect(res.baseline_source).toBe('none_actual_only');
    expect(res.baseline_tokens).toBe(0);
    expect(res.baseline_cost_usd).toBe(0);
    expect(res.net_tokens_saved).toBe(0);
    expect(res.net_cost_saved_usd).toBe(0);
    expect(res.total_tokens).toBeGreaterThan(0);
    expect(res.input_tokens).toBeGreaterThan(0);
    expect(res.output_tokens).toBeGreaterThan(0);
    expect(res.total_cost_usd).toBeGreaterThan(0);
    expect(res.ael_overhead_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not falsely trip negative-savings breaker on live actual-only requests', async () => {
    const wf = 'live_actual_only_wf';
    for (let i = 0; i < 6; i++) {
      const r = await engine.routeAndExecute(`What is 2 + ${i}?`, { workflow_id: wf, task_category: 'factual' });
      expect(r.accounting_mode).toBe('actual_only');
      expect(r.pass_through).toBe(false);
    }
    expect(circuitBreaker.isTripped(wf).tripped).toBe(false);
  });

  it('emits unavailable instead of consensus when single-regime probe has no logprob_confidence', async () => {
    const res = await engine.routeAndExecute('What is 2 + 2?');
    const validSignals = ['externally_verified', 'model_confidence', 'llm_judge_verdict', 'consensus', 'insufficient_evidence', 'unavailable'];
    expect(validSignals).toContain(res.confidence_signal);
    expect(res.confidence_signal).toBe('unavailable');
  });

  it('trips circuit breaker when rolling net savings drop below zero', () => {
    for (let i = 0; i < 6; i++) {
      logStore.insertDecision({
        id: `loss_${i}`,
        timestamp: Date.now() - (10 - i) * 1000,
        workflow_id: 'loss_wf',
        query_hash: 'h',
        task_category: 'test',
        schema_hash: 's',
        baseline_tokens: 100,
        upstream_tokens: 150,
        ael_internal_tokens: 50,
        net_tokens_saved: 0,
        baseline_cost_usd: 0.0001,
        upstream_cost_usd: 0.0002,
        ael_internal_cost_usd: 0.0001,
        net_cost_saved_usd: -0.0002,
        completed_successfully: true,
      } as any);
    }

    const breakerCheck = circuitBreaker.isTripped('loss_wf');
    expect(breakerCheck.tripped).toBe(true);
    expect(breakerCheck.reason).toContain('Negative net savings');
  });

  it('computes unfloored savings only in comparative benchmark mode and trips breaker on token losses (P0-10 + P0-15)', async () => {
    const baseline = await llm.complete('What is 2 + 2?', { reasoning_effort: 'high' });
    const comparative = await engine.routeAndExecute('What is 2 + 2?', {
      task_category: 'factual',
      reference_baseline: { total_tokens: baseline.total_tokens, cost_usd: baseline.cost_usd },
    });
    expect(comparative.accounting_mode).toBe('comparative_benchmark');
    expect(comparative.baseline_source).toBe('comparative_benchmark');
    expect(comparative.net_tokens_saved).toBeGreaterThan(0);

    const wf = 'unfloored_token_loss_wf';
    for (let i = 0; i < 5; i++) {
      const r = await engine.routeAndExecute(`Solve differential equation #${i}`, {
        workflow_id: wf,
        task_category: 'math',
        reference_baseline: { total_tokens: 50, cost_usd: 1.0 },
      });
      expect(r.accounting_mode).toBe('comparative_benchmark');
      expect(r.net_tokens_saved).toBeLessThan(0);
    }

    const recent = logStore.getWorkflowDecisions(wf, 10);
    expect(recent.length).toBe(5);
    expect(recent.every(d => d.net_tokens_saved < 0)).toBe(true);

    const breakerCheck = circuitBreaker.isTripped(wf);
    expect(breakerCheck.tripped).toBe(true);
    expect(breakerCheck.reason).toContain('Negative net token savings');
  });

  it('aggregates exact per-call costs across three deliberately differently priced models in BudgetEngine (P0-23)', async () => {
    const multiLlm = createUnitTestLLMClient(
      {
        default_model: 'tier-default-model',
        cheap_model: 'tier-cheap-model',
        reasoning_model: 'tier-reasoning-model',
        input_cost_per_million: 1.0,
        output_cost_per_million: 2.0,
        reasoning_cost_per_million: 4.0,
        model_pricing: {
          'tier-cheap-model': {
            input_cost_per_million: 0.25,
            output_cost_per_million: 0.5,
            reasoning_cost_per_million: 1.0,
          },
          'tier-default-model': {
            input_cost_per_million: 1.0,
            output_cost_per_million: 2.0,
            reasoning_cost_per_million: 4.0,
          },
          'tier-reasoning-model': {
            input_cost_per_million: 5.0,
            output_cost_per_million: 10.0,
            reasoning_cost_per_million: 20.0,
          },
        },
      },
      (() => {
        let callIndex = 0;
        return (prompt: string, options: { model?: string; temperature?: number }) => {
          callIndex++;
          if (prompt.includes('EVALUATE EVIDENCE')) {
            return {
              text: 'Resolved final theorem proof',
              model: options.model,
              input_tokens: 1200,
              output_tokens: 400,
              reasoning_tokens: 800,
            };
          }
          const labels = ['alpha', 'beta', 'gamma'];
          const tag = labels[(callIndex - 1) % labels.length];
          return {
            text: `answer_${tag}_${callIndex}`,
            model: options.model,
            input_tokens: 1000,
            output_tokens: 200,
            reasoning_tokens: 100,
          };
        };
      })()
    );

    const multiEngine = new BudgetEngine(multiLlm, logStore, circuitBreaker, DEFAULT_PRESETS.quality_first);
    const res = await multiEngine.routeAndExecute('Calculate complex theorem proof', {
      workflow_id: 'multi_model_wf',
      task_category: 'math',
      use_profile_model_tiers: true,
    });

    // quality_first: k_samples=3 -> 1 probe (cheap), 2 samples (default), 1 judge (reasoning)
    expect(res.calls.length).toBe(4);
    expect(res.calls[0].role).toBe('ael_probe');
    expect(res.calls[0].model).toBe('tier-cheap-model');
    expect(res.calls[1].role).toBe('ael_sample');
    expect(res.calls[1].model).toBe('tier-default-model');
    expect(res.calls[2].role).toBe('ael_sample');
    expect(res.calls[2].model).toBe('tier-default-model');
    expect(res.calls[3].role).toBe('ael_judge');
    expect(res.calls[3].model).toBe('tier-reasoning-model');

    const manualSum = Number(res.calls.reduce((sum, c) => sum + c.cost_usd, 0).toFixed(6));
    expect(res.total_cost_usd).toBe(manualSum);
    expect(res.calls[0].cost_usd).toBeCloseTo(0.00045, 6);
    expect(res.calls[1].cost_usd).toBeCloseTo(0.0018, 6);
    expect(res.calls[3].cost_usd).toBeCloseTo(0.026, 6);
    expect(res.total_cost_usd).toBeCloseTo(0.00045 + 0.0018 + 0.0018 + 0.026, 6);
  });
});
