/**
 * End-to-End Unit & Integration Tests: Negative-Savings Circuit Breaker (DoD #6)
 * Uses an isolated unit-test LLM double (never generates benchmark reports or performance evidence).
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerController } from '../src/engines/circuit_breaker.js';
import { BudgetEngine } from '../src/engines/budget.js';
import { LLMClient } from '../src/llm/client.js';
import { DecisionLogStore } from '../src/db/decision_log.js';
import { DEFAULT_PRESETS } from '../src/config/ael_config.js';
import { createUnitTestLLMClient } from './helpers/test_llm_double.js';

describe('Circuit Breaker End-to-End Lifecycle (DoD #6)', () => {
  let logStore: DecisionLogStore;
  let llm: LLMClient;
  let circuitBreaker: CircuitBreakerController;
  let engine: BudgetEngine;

  beforeEach(() => {
    logStore = new DecisionLogStore(':memory:');
    llm = createUnitTestLLMClient({ supports_logprobs: true });

    circuitBreaker = new CircuitBreakerController(
      { enabled: true, rolling_window: 6, min_net_savings_usd: 0.0, max_error_rate: 0.25 },
      logStore
    );

    engine = new BudgetEngine(llm, logStore, circuitBreaker, DEFAULT_PRESETS.balanced);
  });

  it('demonstrates workflow lifecycle: normal savings -> negative savings -> breaker trips -> auto pass-through -> recovery', async () => {
    const workflowId = 'e2e_trading_agent';

    const res1 = await engine.routeAndExecute('What is 10 + 20?', { workflow_id: workflowId });
    expect(res1.pass_through).toBe(false);
    expect(circuitBreaker.isTripped(workflowId).tripped).toBe(false);

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
        ael_internal_tokens: 300,
        net_tokens_saved: 0,
        baseline_cost_usd: 0.0002,
        upstream_cost_usd: 0.00015,
        ael_internal_cost_usd: 0.0003,
        net_cost_saved_usd: -0.00025,
        completed_successfully: true,
      } as any);
    }

    const tripCheck = circuitBreaker.isTripped(workflowId);
    expect(tripCheck.tripped).toBe(true);
    expect(tripCheck.reason).toContain('Negative net savings detected');

    const passThroughRun = await engine.routeAndExecute('Calculate portfolio risk', { workflow_id: workflowId });
    expect(passThroughRun.pass_through).toBe(true);
    expect(passThroughRun.circuit_breaker_tripped).toBe(true);
    expect(passThroughRun.net_cost_saved_usd).toBe(0);

    const summary = logStore.getSummary();
    expect(summary.circuit_breaker_tripped_workflows).toContain(workflowId);

    const trippedList = circuitBreaker.getTrippedWorkflows();
    expect(trippedList.length).toBe(1);
    expect(trippedList[0].workflow_id).toBe(workflowId);

    circuitBreaker.resetWorkflow(workflowId);
    expect(circuitBreaker.isTripped(workflowId).tripped).toBe(false);
  });
});
