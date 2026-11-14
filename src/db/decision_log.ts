/**
 * AEL — Agent Economics Layer
 * SQLite Decision Log (better-sqlite3)
 * Measures Net Savings, Latency, Tool Accuracy & Overhead
 * @license Apache-2.0
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DecisionRecord, DecisionRecordSchema, MetricsSummary } from '../models/contracts.js';

export class DecisionLogStore {
  private db: Database.Database;

  constructor(dbPath: string = './data/ael_decisions.db') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        workflow_id TEXT NOT NULL,
        session_id TEXT,
        query_hash TEXT NOT NULL,
        task_category TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        tool_chosen TEXT,
        tool_args_hash TEXT,
        retries_count INTEGER NOT NULL DEFAULT 0,
        dry_run_executed INTEGER NOT NULL DEFAULT 0,
        dry_run_passed INTEGER,
        dry_run_caught_error TEXT,
        human_approval_granted INTEGER NOT NULL DEFAULT 0,
        regime TEXT NOT NULL DEFAULT 'single',
        reasoning_effort TEXT NOT NULL DEFAULT 'low',
        escalated INTEGER NOT NULL DEFAULT 0,
        escalation_levels INTEGER NOT NULL DEFAULT 0,
        confidence_signal TEXT NOT NULL DEFAULT 'insufficient_evidence',
        samples_count INTEGER NOT NULL DEFAULT 1,
        baseline_tokens INTEGER NOT NULL DEFAULT 0,
        upstream_tokens INTEGER NOT NULL DEFAULT 0,
        ael_internal_tokens INTEGER NOT NULL DEFAULT 0,
        net_tokens_saved INTEGER NOT NULL DEFAULT 0,
        baseline_cost_usd REAL NOT NULL DEFAULT 0.0,
        upstream_cost_usd REAL NOT NULL DEFAULT 0.0,
        ael_internal_cost_usd REAL NOT NULL DEFAULT 0.0,
        net_cost_saved_usd REAL NOT NULL DEFAULT 0.0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        ael_overhead_ms INTEGER NOT NULL DEFAULT 0,
        completed_successfully INTEGER NOT NULL DEFAULT 1,
        circuit_breaker_tripped INTEGER NOT NULL DEFAULT 0,
        pass_through INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_workflow ON decisions(workflow_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(task_category);
    `);
  }

  public insertDecision(decision: DecisionRecord): void {
    const validated = DecisionRecordSchema.parse(decision);
    const stmt = this.db.prepare(`
      INSERT INTO decisions (
        id, timestamp, workflow_id, session_id, query_hash, task_category, schema_hash,
        tool_chosen, tool_args_hash, retries_count, dry_run_executed, dry_run_passed, dry_run_caught_error,
        human_approval_granted, regime, reasoning_effort, escalated, escalation_levels,
        confidence_signal, samples_count, baseline_tokens, upstream_tokens, ael_internal_tokens,
        net_tokens_saved, baseline_cost_usd, upstream_cost_usd, ael_internal_cost_usd,
        net_cost_saved_usd, latency_ms, ael_overhead_ms, completed_successfully,
        circuit_breaker_tripped, pass_through
      ) VALUES (
        @id, @timestamp, @workflow_id, @session_id, @query_hash, @task_category, @schema_hash,
        @tool_chosen, @tool_args_hash, @retries_count, @dry_run_executed, @dry_run_passed, @dry_run_caught_error,
        @human_approval_granted, @regime, @reasoning_effort, @escalated, @escalation_levels,
        @confidence_signal, @samples_count, @baseline_tokens, @upstream_tokens, @ael_internal_tokens,
        @net_tokens_saved, @baseline_cost_usd, @upstream_cost_usd, @ael_internal_cost_usd,
        @net_cost_saved_usd, @latency_ms, @ael_overhead_ms, @completed_successfully,
        @circuit_breaker_tripped, @pass_through
      )
    `);

    stmt.run({
      ...validated,
      session_id: validated.session_id ?? null,
      tool_chosen: validated.tool_chosen ?? null,
      tool_args_hash: validated.tool_args_hash ?? null,
      dry_run_caught_error: validated.dry_run_caught_error ?? null,
      dry_run_executed: validated.dry_run_executed ? 1 : 0,
      dry_run_passed: validated.dry_run_passed === null || validated.dry_run_passed === undefined ? null : (validated.dry_run_passed ? 1 : 0),
      human_approval_granted: validated.human_approval_granted ? 1 : 0,
      escalated: validated.escalated ? 1 : 0,
      completed_successfully: validated.completed_successfully ? 1 : 0,
      circuit_breaker_tripped: validated.circuit_breaker_tripped ? 1 : 0,
      pass_through: validated.pass_through ? 1 : 0,
    });
  }

  public getRecentDecisions(page: number = 1, limit: number = 20): { decisions: DecisionRecord[]; total: number } {
    const offset = Math.max(0, (page - 1) * limit);
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM decisions').get() as { count: number };
    const total = countRow?.count ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM decisions
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

    const decisions = rows.map(r => this.rowToRecord(r));
    return { decisions, total };
  }

  public getWorkflowDecisions(workflowId: string, limit: number = 20): DecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM decisions
      WHERE workflow_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(workflowId, limit) as any[];

    return rows.map(r => this.rowToRecord(r));
  }

  public getSummary(): MetricsSummary {
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM decisions').get() as { count: number };
    const total = countRow?.count ?? 0;

    if (total === 0) {
      return {
        total_requests: 0,
        successful_tasks: 0,
        total_baseline_tokens: 0,
        total_actual_tokens: 0,
        total_net_tokens_saved: 0,
        percent_tokens_saved: 0,
        total_baseline_cost_usd: 0,
        total_actual_cost_usd: 0,
        total_net_cost_saved_usd: 0,
        percent_cost_saved: 0,
        usd_per_completed_task_baseline: 0,
        usd_per_completed_task_ael: 0,
        tool_selection_accuracy: 1.0,
        dry_run_catches_count: 0,
        average_retries: 0,
        p50_latency_ms: 0,
        p95_latency_ms: 0,
        p95_ael_overhead_ms: 0,
        escalation_distribution: { none: 0, low: 0, medium: 0, high: 0 },
        confidence_distribution: { externally_verified: 0, model_confidence: 0, consensus: 0, insufficient_evidence: 0, unavailable: 0 },
        circuit_breaker_tripped_workflows: [],
      };
    }

    const aggRow = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(completed_successfully) as successful_tasks,
        SUM(baseline_tokens) as total_baseline_tokens,
        SUM(upstream_tokens + ael_internal_tokens) as total_actual_tokens,
        SUM(net_tokens_saved) as total_net_tokens_saved,
        SUM(baseline_cost_usd) as total_baseline_cost_usd,
        SUM(upstream_cost_usd + ael_internal_cost_usd) as total_actual_cost_usd,
        SUM(net_cost_saved_usd) as total_net_cost_saved_usd,
        AVG(retries_count) as avg_retries,
        SUM(CASE WHEN dry_run_caught_error IS NOT NULL THEN 1 ELSE 0 END) as dry_run_catches,
        SUM(CASE WHEN (dry_run_passed = 1 OR dry_run_passed IS NULL) AND completed_successfully = 1 THEN 1 ELSE 0 END) as accurate_selections
      FROM decisions
    `).get() as any;

    // Percentiles
    const latencies = (this.db.prepare('SELECT latency_ms FROM decisions ORDER BY latency_ms ASC').all() as any[]).map(r => r.latency_ms);
    const overheads = (this.db.prepare('SELECT ael_overhead_ms FROM decisions ORDER BY ael_overhead_ms ASC').all() as any[]).map(r => r.ael_overhead_ms);
    
    const p50_latency_ms = latencies[Math.floor(latencies.length * 0.50)] ?? 0;
    const p95_latency_ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    const p95_ael_overhead_ms = overheads[Math.floor(overheads.length * 0.95)] ?? 0;

    // Escalation breakdown
    const escalationRows = this.db.prepare(`
      SELECT reasoning_effort, COUNT(*) as cnt FROM decisions GROUP BY reasoning_effort
    `).all() as { reasoning_effort: string; cnt: number }[];
    const escalation_distribution: Record<string, number> = { none: 0, low: 0, medium: 0, high: 0 };
    for (const r of escalationRows) {
      escalation_distribution[r.reasoning_effort] = r.cnt;
    }

    // Confidence breakdown
    const confRows = this.db.prepare(`
      SELECT confidence_signal, COUNT(*) as cnt FROM decisions GROUP BY confidence_signal
    `).all() as { confidence_signal: string; cnt: number }[];
    const confidence_distribution: Record<string, number> = {
      externally_verified: 0,
      model_confidence: 0,
      llm_judge_verdict: 0,
      consensus: 0,
      insufficient_evidence: 0,
      unavailable: 0,
    };
    for (const r of confRows) {
      confidence_distribution[r.confidence_signal] = r.cnt;
    }

    // Circuit breaker workflows
    const trippedRows = this.db.prepare(`
      SELECT DISTINCT workflow_id FROM decisions WHERE circuit_breaker_tripped = 1
    `).all() as { workflow_id: string }[];

    const totalBaseTokens = aggRow.total_baseline_tokens || 1;
    const totalBaseCost = aggRow.total_baseline_cost_usd || 0.0001;
    const successfulTasks = aggRow.successful_tasks || 1;

    const percent_tokens_saved = (aggRow.total_net_tokens_saved / totalBaseTokens) * 100;
    const percent_cost_saved = (aggRow.total_net_cost_saved_usd / totalBaseCost) * 100;

    const tool_selection_accuracy = total > 0 ? (aggRow.accurate_selections / total) : 1.0;

    return {
      total_requests: aggRow.total_requests,
      successful_tasks: aggRow.successful_tasks,
      total_baseline_tokens: aggRow.total_baseline_tokens,
      total_actual_tokens: aggRow.total_actual_tokens,
      total_net_tokens_saved: aggRow.total_net_tokens_saved,
      percent_tokens_saved: Number(percent_tokens_saved.toFixed(1)),
      total_baseline_cost_usd: Number(aggRow.total_baseline_cost_usd.toFixed(4)),
      total_actual_cost_usd: Number(aggRow.total_actual_cost_usd.toFixed(4)),
      total_net_cost_saved_usd: Number(aggRow.total_net_cost_saved_usd.toFixed(4)),
      percent_cost_saved: Number(percent_cost_saved.toFixed(1)),
      usd_per_completed_task_baseline: Number((aggRow.total_baseline_cost_usd / successfulTasks).toFixed(5)),
      usd_per_completed_task_ael: Number((aggRow.total_actual_cost_usd / successfulTasks).toFixed(5)),
      tool_selection_accuracy: Number(tool_selection_accuracy.toFixed(3)),
      dry_run_catches_count: aggRow.dry_run_catches,
      average_retries: Number((aggRow.avg_retries || 0).toFixed(2)),
      p50_latency_ms,
      p95_latency_ms,
      p95_ael_overhead_ms,
      escalation_distribution,
      confidence_distribution,
      circuit_breaker_tripped_workflows: trippedRows.map(r => r.workflow_id),
    };
  }

  private rowToRecord(r: any): DecisionRecord {
    return {
      id: r.id,
      timestamp: r.timestamp,
      workflow_id: r.workflow_id,
      session_id: r.session_id,
      query_hash: r.query_hash,
      task_category: r.task_category,
      schema_hash: r.schema_hash,
      tool_chosen: r.tool_chosen,
      tool_args_hash: r.tool_args_hash,
      retries_count: r.retries_count,
      dry_run_executed: Boolean(r.dry_run_executed),
      dry_run_passed: r.dry_run_passed === null ? null : Boolean(r.dry_run_passed),
      dry_run_caught_error: r.dry_run_caught_error,
      human_approval_granted: Boolean(r.human_approval_granted),
      regime: r.regime,
      reasoning_effort: r.reasoning_effort,
      escalated: Boolean(r.escalated),
      escalation_levels: r.escalation_levels,
      confidence_signal: r.confidence_signal,
      samples_count: r.samples_count,
      baseline_tokens: r.baseline_tokens,
      upstream_tokens: r.upstream_tokens,
      ael_internal_tokens: r.ael_internal_tokens,
      net_tokens_saved: r.net_tokens_saved,
      baseline_cost_usd: r.baseline_cost_usd,
      upstream_cost_usd: r.upstream_cost_usd,
      ael_internal_cost_usd: r.ael_internal_cost_usd,
      net_cost_saved_usd: r.net_cost_saved_usd,
      latency_ms: r.latency_ms,
      ael_overhead_ms: r.ael_overhead_ms,
      completed_successfully: Boolean(r.completed_successfully),
      circuit_breaker_tripped: Boolean(r.circuit_breaker_tripped),
      pass_through: Boolean(r.pass_through),
    };
  }

  public close(): void {
    this.db.close();
  }
}

let defaultInstance: DecisionLogStore | null = null;
export function getDecisionLog(dbPath?: string): DecisionLogStore {
  if (!defaultInstance) {
    defaultInstance = new DecisionLogStore(dbPath);
  }
  return defaultInstance;
}
