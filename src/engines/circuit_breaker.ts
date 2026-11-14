/**
 * AEL — Agent Economics Layer
 * Negative-Savings Circuit Breaker
 * Protects workflows from losing money by tripping to pass-through mode
 * @license Apache-2.0
 */

import { CircuitBreakerConfig } from '../config/ael_config.js';
import { DecisionLogStore } from '../db/decision_log.js';
import { DecisionRecord } from '../models/contracts.js';

export interface WorkflowBreakerState {
  workflow_id: string;
  tripped: boolean;
  tripped_reason?: string;
  rolling_requests_count: number;
  rolling_net_savings_usd: number;
  rolling_error_rate: number;
  last_evaluated: number;
}

export class CircuitBreakerController {
  private trippedWorkflows: Map<string, { tripped: boolean; reason: string; timestamp: number }> = new Map();
  private resetTimestamps: Map<string, number> = new Map();

  constructor(
    private config: CircuitBreakerConfig,
    private logStore: DecisionLogStore
  ) {}

  public isTripped(workflow_id: string): { tripped: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { tripped: false };
    }

    const cached = this.trippedWorkflows.get(workflow_id);
    if (cached && cached.tripped) {
      return { tripped: true, reason: cached.reason };
    }

    const resetAfter = this.resetTimestamps.get(workflow_id) || 0;
    // Evaluate rolling window from decision log
    const recent = this.logStore
      .getWorkflowDecisions(workflow_id, this.config.rolling_window)
      .filter(r => r.timestamp > resetAfter);

    if (recent.length < 5) {
      // Need minimum history after reset before tripping
      return { tripped: false };
    }

    const netSavings = recent.reduce((sum, r) => sum + r.net_cost_saved_usd, 0);
    const netTokensSaved = recent.reduce((sum, r) => sum + r.net_tokens_saved, 0);
    const failureCount = recent.filter(r => !r.completed_successfully).length;
    const errorRate = failureCount / recent.length;

    if (netSavings <= this.config.min_net_savings_usd) {
      const reason = `Negative net savings detected over rolling window of ${recent.length} requests: $${netSavings.toFixed(5)} <= $${this.config.min_net_savings_usd}`;
      this.trippedWorkflows.set(workflow_id, { tripped: true, reason, timestamp: Date.now() });
      console.warn(`[AEL Circuit Breaker] TRIPPED for workflow '${workflow_id}': ${reason}`);
      return { tripped: true, reason };
    }

    if (netTokensSaved < 0) {
      const reason = `Negative net token savings detected over rolling window of ${recent.length} requests: ${netTokensSaved} tokens`;
      this.trippedWorkflows.set(workflow_id, { tripped: true, reason, timestamp: Date.now() });
      console.warn(`[AEL Circuit Breaker] TRIPPED for workflow '${workflow_id}': ${reason}`);
      return { tripped: true, reason };
    }

    if (errorRate > this.config.max_error_rate) {
      const reason = `Excessive error rate over rolling window: ${(errorRate * 100).toFixed(1)}% > ${(this.config.max_error_rate * 100).toFixed(1)}%`;
      this.trippedWorkflows.set(workflow_id, { tripped: true, reason, timestamp: Date.now() });
      console.warn(`[AEL Circuit Breaker] TRIPPED for workflow '${workflow_id}': ${reason}`);
      return { tripped: true, reason };
    }

    return { tripped: false };
  }

  public resetWorkflow(workflow_id: string): void {
    this.trippedWorkflows.delete(workflow_id);
    this.resetTimestamps.set(workflow_id, Date.now());
  }

  public getTrippedWorkflows(): Array<{ workflow_id: string; reason: string; timestamp: number }> {
    return Array.from(this.trippedWorkflows.entries()).map(([workflow_id, data]) => ({
      workflow_id,
      reason: data.reason,
      timestamp: data.timestamp,
    }));
  }
}
