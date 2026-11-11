/**
 * Extended Unit Tests: Thinking Budget Engine & Scaling Regimes
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetEngine } from '../src/engines/budget.js';
import { CircuitBreakerController } from '../src/engines/circuit_breaker.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { DEFAULT_PRESETS } from '../src/config/ael_config.js';

describe('BudgetEngine Scaling Regimes & Escalation', () => {
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let circuitBreaker: CircuitBreakerController;
  let engine: BudgetEngine;

  beforeEach(() => {
    logStore = new DecisionLogStore(':memory:');
    llm = new LLMClient({
      name: 'mock',
      type: 'mock',
      api_key_env: 'KEY',
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
      { enabled: true, rolling_window: 20, min_net_savings_usd: 0, max_error_rate: 0.2 },
      logStore
    );
    engine = new BudgetEngine(llm, logStore, circuitBreaker, DEFAULT_PRESETS.balanced);
  });

  it('runs sample scaling regime with k samples consensus aggregation', async () => {
    const res = await engine.routeAndExecute('Verify theorem proof', {
      policy: DEFAULT_PRESETS.quality_first,
      task_category: 'math',
    });

    expect(res.regime).toBe('sample');
    expect(res.samples_generated).toBeGreaterThanOrEqual(1);
    expect(res.total_tokens).toBeGreaterThan(0);
  });

  it('escalates to verifier when query complexity triggers escalation', async () => {
    const res = await engine.routeAndExecute(
      'Calculate differential equation optimization algorithm proof with matrix constraints',
      {
        policy: DEFAULT_PRESETS.balanced,
        task_category: 'math',
      }
    );

    expect(res.escalated).toBe(true);
    expect(res.escalation_levels).toBeGreaterThanOrEqual(1);
    expect(res.confidence_signal).toBe('model_confidence');
    expect(res.ael_internal_tokens).toBeGreaterThan(0);
  });

  it('respects global pass_through option and logs baseline costs without intervention', async () => {
    const res = await engine.routeAndExecute('Simple test query', { pass_through: true });
    expect(res.pass_through).toBe(true);
    expect(res.final_effort).toBe('high');
    expect(res.net_cost_saved_usd).toBe(0);
  });
});
