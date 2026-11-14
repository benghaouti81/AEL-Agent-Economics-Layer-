/**
 * Unit Tests: Thinking Budget Engine & Circuit Breaker
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BudgetEngine } from '../src/engines/budget.js';
import { CircuitBreakerController } from '../src/engines/circuit_breaker.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { DEFAULT_PRESETS } from '../src/config/ael_config.js';

describe('Budget Engine & Circuit Breaker', () => {
  const originalAllowMock = process.env.AEL_ALLOW_MOCK;
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let circuitBreaker: CircuitBreakerController;
  let engine: BudgetEngine;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
    logStore = new DecisionLogStore(':memory:');
    llm = new LLMClient({
      name: 'mock',
      type: 'mock',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'mock',
      cheap_model: 'mock',
      reasoning_model: 'mock',
      supports_reasoning_effort: true,
      supports_logprobs: true,
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
    });
    circuitBreaker = new CircuitBreakerController(
      { enabled: true, rolling_window: 5, min_net_savings_usd: 0, max_error_rate: 0.2 },
      logStore
    );
    engine = new BudgetEngine(llm, logStore, circuitBreaker, DEFAULT_PRESETS.balanced);
  });

  afterEach(() => {
    if (originalAllowMock === undefined) delete process.env.AEL_ALLOW_MOCK;
    else process.env.AEL_ALLOW_MOCK = originalAllowMock;
  });

  it('allocates cheap compute for simple queries and reports net savings', async () => {
    const res = await engine.routeAndExecute('What is 2 + 2?', { task_category: 'factual' });
    expect(res.final_effort).toBe('low');
    expect(res.escalated).toBe(false);
    expect(res.total_tokens).toBeLessThan(res.baseline_tokens);
    expect(res.net_cost_saved_usd).toBeGreaterThan(0);
    expect(res.ael_overhead_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits unavailable instead of consensus when single-regime probe has no logprob_confidence', async () => {
    const res = await engine.routeAndExecute('What is 2 + 2?');
    const validSignals = ['externally_verified', 'model_confidence', 'llm_judge_verdict', 'consensus', 'insufficient_evidence', 'unavailable'];
    expect(validSignals).toContain(res.confidence_signal);
    expect(res.confidence_signal).toBe('unavailable');
  });

  it('trips circuit breaker when rolling net savings drop below zero', () => {
    // Inject negative savings decisions into workflow 'loss_wf'
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
        net_cost_saved_usd: -0.0002, // Negative savings!
        completed_successfully: true,
      } as any);
    }

    const breakerCheck = circuitBreaker.isTripped('loss_wf');
    expect(breakerCheck.tripped).toBe(true);
    expect(breakerCheck.reason).toContain('Negative net savings');
  });

  it('removes hardcoded 800/120 constants, exposes unfloored negative net_tokens_saved, and trips breaker on token losses (P0-10)', async () => {
    // 1. Measured reference baseline reflects actual LLM baseline call
    const measured = await engine.routeAndExecute('What is 2 + 2?', { task_category: 'factual' });
    expect(measured.baseline_source).toBe('measured_reference');
    expect(measured.assumed_baseline).toBeUndefined();

    // 2. When measure_baseline is false, emits explicitly labeled assumed_baseline
    const assumed = await engine.routeAndExecute('Calculate matrix eigenvalues for differential optimization', {
      task_category: 'math',
      measure_baseline: false,
    });
    expect(assumed.baseline_source).toBe('assumed_baseline');
    expect(assumed.assumed_baseline).toBeDefined();
    // Escalation costs more tokens than unescalated probe -> negative net_tokens_saved must be visible (not floored to 0)
    expect(assumed.net_tokens_saved).toBeLessThan(0);

    // 3. Passing small reference_baseline exposes unfloored negative net_tokens_saved in result & DecisionLogStore, tripping circuit breaker
    const wf = 'unfloored_token_loss_wf';
    for (let i = 0; i < 5; i++) {
      const r = await engine.routeAndExecute(`Solve differential equation #${i}`, {
        workflow_id: wf,
        task_category: 'math',
        reference_baseline: { total_tokens: 50, cost_usd: 1.0 },
      });
      expect(r.net_tokens_saved).toBeLessThan(0);
    }

    const recent = logStore.getWorkflowDecisions(wf, 10);
    expect(recent.length).toBe(5);
    expect(recent.every(d => d.net_tokens_saved < 0)).toBe(true);

    const breakerCheck = circuitBreaker.isTripped(wf);
    expect(breakerCheck.tripped).toBe(true);
    expect(breakerCheck.reason).toContain('Negative net token savings');
  });
});
