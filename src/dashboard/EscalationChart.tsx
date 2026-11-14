/**
 * AEL Dashboard — Escalation & Confidence Distribution Chart
 * Visualizes reasoning compute tiers and the 4-tier confidence signal taxonomy
 * @license Apache-2.0
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { MetricsSummary } from '../models/contracts.js';

interface EscalationChartProps {
  summary: MetricsSummary;
}

export const EscalationChart: React.FC<EscalationChartProps> = ({ summary }) => {
  const effortData = [
    { name: 'None (Probe)', count: summary.escalation_distribution.none || 0, fill: '#10b981' },
    { name: 'Low', count: summary.escalation_distribution.low || 0, fill: '#06b6d4' },
    { name: 'Medium', count: summary.escalation_distribution.medium || 0, fill: '#3b82f6' },
    { name: 'High', count: summary.escalation_distribution.high || 0, fill: '#f59e0b' },
  ];

  const confidenceData = [
    { label: 'Externally Verified', count: summary.confidence_distribution.externally_verified || 0, color: 'text-emerald-400' },
    { label: 'Model Confidence', count: summary.confidence_distribution.model_confidence || 0, color: 'text-cyan-400' },
    { label: 'Consensus (k Samples)', count: summary.confidence_distribution.consensus || 0, color: 'text-blue-400' },
    { label: 'Insufficient Evidence', count: summary.confidence_distribution.insufficient_evidence || 0, color: 'text-amber-400' },
    { label: 'Unavailable', count: summary.confidence_distribution.unavailable || 0, color: 'text-slate-400' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Chart: Reasoning Compute Escalation */}
      <div className="lg:col-span-2 bg-slate-900/60 border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold text-slate-200">Test-Time Compute Escalation Distribution</div>
            <div className="text-xs text-slate-400 mt-0.5">AERA adaptive reasoning allocation vs fixed uniform effort</div>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-400">
            {summary.total_requests} decisions evaluated
          </div>
        </div>

        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={effortData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="name" stroke="#64748b" fontSize={11} tickLine={false} />
              <YAxis stroke="#64748b" fontSize={11} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '6px', fontSize: '12px' }}
                itemStyle={{ color: '#f8fafc' }}
                cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {effortData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Breakdown: 4-Level Confidence Taxonomy */}
      <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-200">Confidence Signal Taxonomy</div>
          <div className="text-xs text-slate-400 mt-0.5">Authoritative 4-tier decision taxonomy</div>
        </div>

        <div className="space-y-3 my-4">
          {confidenceData.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between text-xs">
              <span className="text-slate-300">{item.label}</span>
              <span className={`font-mono tabular-nums font-semibold ${item.color}`}>
                {item.count}
              </span>
            </div>
          ))}
        </div>

        <div className="text-[11px] text-slate-400 pt-3 border-t border-slate-800/80 leading-relaxed">
          Self-consistency consensus is recorded as an empirical stopping heuristic, not mathematical proof.
        </div>
      </div>
    </div>
  );
};
