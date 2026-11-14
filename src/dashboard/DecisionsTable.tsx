/**
 * AEL Dashboard — Recent Decisions Table
 * High-density financial-grade decision ledger with zero pills and tabular numerals
 * @license Apache-2.0
 */

import React from 'react';
import { DecisionRecord } from '../models/contracts.js';

interface DecisionsTableProps {
  decisions: DecisionRecord[];
  total: number;
  page: number;
  limit: number;
  loading: boolean;
  onPageChange: (newPage: number) => void;
}

export const DecisionsTable: React.FC<DecisionsTableProps> = ({
  decisions,
  total,
  page,
  limit,
  loading,
  onPageChange,
}) => {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 border-b border-slate-800 gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-200">Recent Decision Traces</div>
          <div className="text-xs text-slate-400 mt-0.5">
            Page {page} of {totalPages} <span className="mx-1 text-slate-600">·</span> {total} total recorded decisions
          </div>
        </div>

        {/* Pagination Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-200 rounded transition-colors whitespace-nowrap"
          >
            Previous
          </button>
          <span className="text-xs font-mono tabular-nums text-slate-400 px-1">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || loading}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-200 rounded transition-colors whitespace-nowrap"
          >
            Next
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="bg-slate-950/40 text-slate-400 border-b border-slate-800 font-medium">
              <th className="py-2.5 px-4 whitespace-nowrap">Timestamp</th>
              <th className="py-2.5 px-4 whitespace-nowrap">Workflow</th>
              <th className="py-2.5 px-4 whitespace-nowrap">Category</th>
              <th className="py-2.5 px-4 whitespace-nowrap">Decision Action</th>
              <th className="py-2.5 px-4 whitespace-nowrap">Confidence Signal</th>
              <th className="py-2.5 px-4 text-right whitespace-nowrap">Tokens (Act / Saved)</th>
              <th className="py-2.5 px-4 text-right whitespace-nowrap">Net Saved ($)</th>
              <th className="py-2.5 px-4 text-right whitespace-nowrap">Latency</th>
              <th className="py-2.5 px-4 text-right whitespace-nowrap">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono">
            {loading ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-slate-400 font-sans text-xs">
                  Loading decision ledger...
                </td>
              </tr>
            ) : decisions.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-slate-400 font-sans text-xs">
                  No decisions recorded yet. Run `ael eval` or execute an agent request to log decisions.
                </td>
              </tr>
            ) : (
              decisions.map((d) => {
                const dateStr = new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const actualTokens = d.upstream_tokens + d.ael_internal_tokens;

                return (
                  <tr key={d.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">{dateStr}</td>
                    <td className="py-2.5 px-4 text-slate-300 font-sans truncate max-w-[120px]">{d.workflow_id}</td>
                    <td className="py-2.5 px-4 text-slate-400 font-sans capitalize">{d.task_category}</td>
                    <td className="py-2.5 px-4 text-slate-200 font-sans">
                      {d.tool_chosen ? (
                        <span>
                          <span className="text-cyan-300">{d.tool_chosen}</span>
                          {d.dry_run_executed && <span className="text-[10px] text-emerald-400 ml-1.5">· dry-run</span>}
                          {d.retries_count > 0 && <span className="text-[10px] text-amber-400 ml-1.5">· {d.retries_count}r</span>}
                        </span>
                      ) : (
                        <span>
                          <span className="text-slate-300">{d.regime}</span>
                          <span className="text-slate-500 mx-1">/</span>
                          <span className="text-cyan-400">{d.reasoning_effort}</span>
                          {d.escalated && <span className="text-[10px] text-amber-400 ml-1.5">· escalated</span>}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 font-sans text-[11px]">
                      {d.confidence_signal === 'externally_verified' && <span className="text-emerald-400">verified</span>}
                      {d.confidence_signal === 'model_confidence' && <span className="text-cyan-400">model-conf</span>}
                      {d.confidence_signal === 'consensus' && <span className="text-blue-400">consensus</span>}
                      {d.confidence_signal === 'insufficient_evidence' && <span className="text-slate-400">insufficient</span>}
                      {d.confidence_signal === 'unavailable' && <span className="text-slate-500">unavailable</span>}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap">
                      <span className="text-slate-300">{actualTokens}</span>
                      <span className="text-slate-600 mx-1">/</span>
                      <span className="text-emerald-400">+{d.net_tokens_saved}</span>
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-emerald-400 whitespace-nowrap">
                      ${d.net_cost_saved_usd.toFixed(4)}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-slate-400 whitespace-nowrap">
                      {d.latency_ms}ms
                    </td>
                    <td className="py-2.5 px-4 text-right font-sans whitespace-nowrap">
                      {d.pass_through ? (
                        <span className="text-amber-400">pass-through</span>
                      ) : d.completed_successfully ? (
                        <span className="text-emerald-400">success</span>
                      ) : (
                        <span className="text-rose-400">failed</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
