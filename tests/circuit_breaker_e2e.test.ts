/**
 * End-to-End Unit & Integration Tests: Negative-Savings Circuit Breaker (DoD #6)
 * Demonstrates a scripted workflow where rolling net savings drop <= 0,
 * the breaker trips to pass-through mode, surfaces in telemetry, and resets.
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerController } from '../src/engines/circuit_breaker.js';
import { BudgetEngine } from '../src/engines/budget.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { DEFAULT_PRESETS } from '../src/config/ael_config.js';

describe('Circuit Breaker End-to-End Lifecycle (DoD #6)', () => {
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
      { enabled: true, rolling_window: 6, min_net_savings_usd: 0.0, max_error_rate: 0.25 },
      logStore
    );

    engine = new BudgetEngine(llm, logStore, circuitBreaker, DEFAULT_PRESETS.balanced);
  });

  it('demonstrates workflow lifecycle: normal savings -> negative savings -> breaker trips -> auto pass-through -> recovery', async () => {
    const workflowId = 'e2e_trading_agent';

    // 1. Initial State: Normal healthy requests
    const res1 = await engine.routeAndExecute('What is 10 + 20?', { workflow_id: workflowId });
    expect(res1.pass_through).toBe(false);
    expect(circuitBreaker.isTripped(workflowId).tripped).toBe(false);

    // 2. Inject a series of negative-saving decisions (AEL internal overhead exceeds baseline)
    for (let i = 0; i < 6; i++) {
      logStore.insertDecision({
        id: `loss_tx_${i}`,
        timestamp: Date.now() - (10 - i) * 500,
        workflow_id: workflowId,
        query_hash: `q_loss_${i}`,
        task_category: 'financial_eval',
        schema_hash: 'n/a',
        baseline_tokens: 200,
        upstream_tokens: 150,
        ael_internal_tokens: 300, // Overhead exceeds baseline
        net_tokens_saved: 0,
        baseline_cost_usd: 0.0002,
        upstream_cost_usd: 0.00015,
        ael_internal_cost_usd: 0.0003,
        net_cost_saved_usd: -0.00025, // Negative savings per request!
        completed_successfully: true,
      } as any);
    }

    // 3. Breaker evaluates rolling window: net savings <= 0 triggers trip!
    const tripCheck = circuitBreaker.isTripped(workflowId);
    expect(tripCheck.tripped).toBe(true);
    expect(tripCheck.reason).toContain('Negative net savings detected');

    // 4. Subsequent request through BudgetEngine automatically trips to pass-through
    const passThroughRun = await engine.routeAndExecute('Calculate portfolio risk', { workflow_id: workflowId });
    expect(passThroughRun.pass_through).toBe(true);
    expect(passThroughRun.circuit_breaker_tripped).toBe(true);
    expect(passThroughRun.net_cost_saved_usd).toBe(0); // 0 savings claimed during pass-through

    // 5. Telemetry surfaces the tripped workflow
    const summary = logStore.getSummary();
    expect(summary.circuit_breaker_tripped_workflows).toContain(workflowId);

    const trippedList = circuitBreaker.getTrippedWorkflows();
    expect(trippedList.length).toBe(1);
    expect(trippedList[0].workflow_id).toBe(workflowId);

    // 6. Resetting the workflow restores active economic optimization
    circuitBreaker.resetWorkflow(workflowId);
    expect(circuitBreaker.isTripped(workflowId).tripped).toBe(false);
  });
});
