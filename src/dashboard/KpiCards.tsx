/**
 * AEL Dashboard — KPI Cards Strip
 * Clean financial-grade metrics display without decorative pill badges
 * @license Apache-2.0
 */

import React from 'react';
import { MetricsSummary } from '../models/contracts.js';

interface KpiCardsProps {
  summary: MetricsSummary;
}

export const KpiCards: React.FC<KpiCardsProps> = ({ summary }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* KPI 1: Net Tokens Saved */}
      <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-lg">
        <div className="text-xs font-medium text-slate-400 mb-1">Net Tokens Saved</div>
        <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
          {summary.total_net_tokens_saved.toLocaleString()}
        </div>
        <div className="mt-2 text-xs text-slate-400">
          <span className="font-mono tabular-nums text-emerald-400">+{summary.percent_tokens_saved}%</span>
          <span className="mx-1.5 text-slate-600">·</span>
          <span>vs fixed-high baseline</span>
        </div>
      </div>

      {/* KPI 2: Net Cost Saved */}
      <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-lg">
        <div className="text-xs font-medium text-slate-400 mb-1">Net Cost Saved (USD)</div>
        <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
          ${summary.total_net_cost_saved_usd.toFixed(4)}
        </div>
        <div className="mt-2 text-xs text-slate-400">
          <span className="font-mono tabular-nums text-emerald-400">+{summary.percent_cost_saved}%</span>
          <span className="mx-1.5 text-slate-600">·</span>
          <span>net of AEL overhead</span>
        </div>
      </div>

      {/* KPI 3: Headline Metric: USD per Completed Task */}
      <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-lg">
        <div className="text-xs font-medium text-slate-400 mb-1">Cost / Completed Task</div>
        <div className="text-2xl font-bold font-mono tabular-nums text-cyan-400">
          ${summary.usd_per_completed_task_ael.toFixed(5)}
        </div>
        <div className="mt-2 text-xs text-slate-400">
          <span className="line-through text-slate-500 font-mono tabular-nums">${summary.usd_per_completed_task_baseline.toFixed(5)}</span>
          <span className="mx-1.5 text-slate-600">·</span>
          <span className="text-slate-300 font-mono tabular-nums">{summary.successful_tasks} tasks</span>
        </div>
      </div>

      {/* KPI 4: Tool Selection Accuracy & Dry-Run Catches */}
      <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-lg">
        <div className="text-xs font-medium text-slate-400 mb-1">Tool Accuracy (Tool-DC)</div>
        <div className="text-2xl font-bold font-mono tabular-nums text-slate-100">
          {(summary.tool_selection_accuracy * 100).toFixed(1)}%
        </div>
        <div className="mt-2 text-xs text-slate-400">
          <span className="text-amber-400 font-mono tabular-nums">{summary.dry_run_catches_count} dry-run catches</span>
          <span className="mx-1.5 text-slate-600">·</span>
          <span className="font-mono tabular-nums">avg {summary.average_retries} retries</span>
        </div>
      </div>
    </div>
  );
};
