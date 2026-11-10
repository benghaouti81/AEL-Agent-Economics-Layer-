/**
 * AEL Dashboard — Latency & Overhead Breakdown
 * Verifies p95 middleware decision overhead < 500ms contract
 * @license Apache-2.0
 */

import React from 'react';
import { MetricsSummary } from '../models/contracts.js';

interface LatencyBreakdownProps {
  summary: MetricsSummary;
}

export const LatencyBreakdown: React.FC<LatencyBreakdownProps> = ({ summary }) => {
  const overheadPassed = summary.p95_ael_overhead_ms < 500;

  return (
    <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-lg">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-200">Middleware Latency & Decision Overhead</div>
          <div className="text-xs text-slate-400 mt-0.5">Strict SLO Contract: p95 decision overhead &lt; 500ms</div>
        </div>
        <div className="text-xs font-mono">
          Contract Status:{' '}
          <span className={overheadPassed ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
            {overheadPassed ? 'PASSED (<500ms)' : 'BREACH'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
        <div>
          <div className="text-xs text-slate-400 mb-1">p50 Request Latency</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-200">
            {summary.p50_latency_ms} <span className="text-xs font-normal text-slate-500">ms</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">End-to-end median</div>
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-1">p95 Request Latency</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-200">
            {summary.p95_latency_ms} <span className="text-xs font-normal text-slate-500">ms</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">95th percentile tail</div>
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-1">p95 AEL Decision Overhead</div>
          <div className={`text-xl font-bold font-mono tabular-nums ${overheadPassed ? 'text-emerald-400' : 'text-rose-400'}`}>
            {summary.p95_ael_overhead_ms} <span className="text-xs font-normal text-slate-500">ms</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Excluding upstream inference</div>
        </div>
      </div>
    </div>
  );
};
