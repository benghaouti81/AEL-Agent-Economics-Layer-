/**
 * Unit Tests: Decision Log Store (better-sqlite3)
 * @license Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DecisionLogStore } from '../src/db/decision_log.js';

describe('DecisionLogStore', () => {
  it('inserts and retrieves decisions accurately with pagination', () => {
    const store = new DecisionLogStore(':memory:');

    store.insertDecision({
      id: 'd1',
      timestamp: Date.now(),
      workflow_id: 'test_wf',
      query_hash: 'q1',
      task_category: 'factual',
      schema_hash: 's1',
      baseline_tokens: 1000,
      upstream_tokens: 200,
      ael_internal_tokens: 50,
      net_tokens_saved: 750,
      baseline_cost_usd: 0.001,
      upstream_cost_usd: 0.0002,
      ael_internal_cost_usd: 0.00005,
      net_cost_saved_usd: 0.00075,
      latency_ms: 45,
      ael_overhead_ms: 5,
      completed_successfully: true,
    } as any);

    const { decisions, total } = store.getRecentDecisions(1, 10);
    expect(total).toBe(1);
    expect(decisions[0].id).toBe('d1');
    expect(decisions[0].net_tokens_saved).toBe(750);

    const summary = store.getSummary();
    expect(summary.total_requests).toBe(1);
    expect(summary.total_net_tokens_saved).toBe(750);
    expect(summary.percent_tokens_saved).toBe(75);
    expect(summary.usd_per_completed_task_ael).toBeGreaterThan(0);
  });

  it('preserves negative net_tokens_saved and negative summary percentages without flooring to zero', () => {
    const store = new DecisionLogStore(':memory:');

    store.insertDecision({
      id: 'd_neg',
      timestamp: Date.now(),
      workflow_id: 'loss_wf',
      query_hash: 'q_neg',
      task_category: 'math',
      schema_hash: 's1',
      baseline_tokens: 200,
      upstream_tokens: 150,
      ael_internal_tokens: 250,
      net_tokens_saved: -200,
      baseline_cost_usd: 0.0002,
      upstream_cost_usd: 0.00015,
      ael_internal_cost_usd: 0.00025,
      net_cost_saved_usd: -0.0002,
      latency_ms: 40,
      ael_overhead_ms: 2,
      completed_successfully: true,
    } as any);

    const { decisions } = store.getRecentDecisions(1, 10);
    expect(decisions[0].net_tokens_saved).toBe(-200);

    const summary = store.getSummary();
    expect(summary.total_net_tokens_saved).toBe(-200);
    expect(summary.percent_tokens_saved).toBeLessThan(0);
    expect(summary.percent_cost_saved).toBeLessThan(0);
  });
});
