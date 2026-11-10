/**
 * AEL Dashboard — Root View
 * Single read-only dashboard served at /dashboard and /
 * Strictly powered by GET /api/metrics/summary and GET /api/metrics/decisions
 * @license Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { MetricsSummary, DecisionRecord } from '../models/contracts.js';
import { KpiCards } from './KpiCards.js';
import { EscalationChart } from './EscalationChart.js';
import { LatencyBreakdown } from './LatencyBreakdown.js';
import { DecisionsTable } from './DecisionsTable.js';
import { CircuitBreakerBanner } from './CircuitBreakerBanner.js';

export const Dashboard: React.FC = () => {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [totalDecisions, setTotalDecisions] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (targetPage: number = 1) => {
    try {
      setLoading(true);
      setError(null);

      const [summaryRes, decisionsRes] = await Promise.all([
        fetch('/api/metrics/summary'),
        fetch(`/api/metrics/decisions?page=${targetPage}&limit=12`),
      ]);

      if (!summaryRes.ok || !decisionsRes.ok) {
        throw new Error('Failed to retrieve metrics from AEL API server.');
      }

      const summaryData = await summaryRes.json();
      const decisionsData = await decisionsRes.json();

      setSummary(summaryData);
      setDecisions(decisionsData.decisions || []);
      setTotalDecisions(decisionsData.total || 0);
      setPage(targetPage);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData(1);
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData(page);
  };

  const handleRunEval = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/eval/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suite: 'all' }) });
      await fetchData(1);
    } catch (err: any) {
      setError(`Evaluation run failed: ${err.message}`);
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Bar Contract: Zone 1 (Wordmark) — Zone 2 (Clean links) — Zone 3 (Action) */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-20">
        {/* Zone 1: Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <a href="/" className="text-base font-bold tracking-tight text-white whitespace-nowrap">
            AEL
          </a>
          <span className="text-slate-600">/</span>
          <span className="text-xs text-slate-400 font-mono">Agent Economics Layer</span>
        </div>

        {/* Zone 2: Navigation / Metadata */}
        <nav className="hidden md:flex items-center gap-6 text-xs text-slate-400">
          <span className="hover:text-slate-200 transition-colors whitespace-nowrap">Tool-DC FSM</span>
          <span className="text-slate-700">·</span>
          <span className="hover:text-slate-200 transition-colors whitespace-nowrap">AERA / CoBa Engine</span>
          <span className="text-slate-700">·</span>
          <span className="hover:text-slate-200 transition-colors whitespace-nowrap">SQLite LogStore</span>
        </nav>

        {/* Zone 3: Actions */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleRunEval}
            disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded transition-colors whitespace-nowrap disabled:opacity-50"
          >
            Run Eval Suite
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3.5 py-1.5 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded transition-colors whitespace-nowrap disabled:opacity-50"
          >
            {refreshing ? 'Updating...' : 'Refresh Metrics'}
          </button>
        </div>
      </header>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {error && (
          <div className="bg-rose-950/50 border border-rose-800/80 p-4 rounded-lg text-xs text-rose-200">
            {error}
          </div>
        )}

        {summary && (
          <>
            {/* Circuit Breaker Status Banner */}
            <CircuitBreakerBanner trippedWorkflows={summary.circuit_breaker_tripped_workflows || []} />

            {/* Savings & Accuracy KPIs */}
            <KpiCards summary={summary} />

            {/* Compute Escalation & Confidence Taxonomy */}
            <EscalationChart summary={summary} />

            {/* Latency & Overhead Contract */}
            <LatencyBreakdown summary={summary} />

            {/* Recent Decisions Ledger */}
            <DecisionsTable
              decisions={decisions}
              total={totalDecisions}
              page={page}
              limit={12}
              loading={loading}
              onPageChange={(newPage) => fetchData(newPage)}
            />
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 px-6 py-4 text-xs text-slate-400 flex flex-col sm:flex-row items-center justify-between gap-2 max-w-7xl w-full mx-auto">
        <div>
          AEL v0.1.0 <span className="mx-1.5 text-slate-700">·</span> Apache-2.0 License <span className="mx-1.5 text-slate-700">·</span> CLI: <code className="text-slate-300 font-mono">ael report</code>
        </div>
        <div className="font-mono text-[11px] text-slate-400">
          Based on Tool-DC (arXiv:2603.11495) & AERA (arXiv:2608.27964)
        </div>
      </footer>
    </div>
  );
};
