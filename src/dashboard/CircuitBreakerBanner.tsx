/**
 * AEL Dashboard — Circuit Breaker Banner
 * Displays quiet status notification if any workflow has tripped to pass-through mode
 * @license Apache-2.0
 */

import React from 'react';

interface CircuitBreakerBannerProps {
  trippedWorkflows: string[];
}

export const CircuitBreakerBanner: React.FC<CircuitBreakerBannerProps> = ({ trippedWorkflows }) => {
  if (trippedWorkflows.length === 0) {
    return null;
  }

  return (
    <div className="bg-amber-950/40 border border-amber-800/80 p-4 rounded-lg flex items-start gap-3 text-xs text-amber-200">
      <div className="font-semibold text-amber-400 shrink-0">Circuit Breaker Active:</div>
      <div className="flex-1 leading-relaxed">
        The following workflows have automatically tripped to pass-through mode due to negative rolling savings or policy thresholds:
        <span className="font-mono text-amber-300 ml-1.5 font-semibold">
          {trippedWorkflows.join(', ')}
        </span>.
        Requests in these workflows bypass adaptive interventions until reset or historical performance recovers.
      </div>
    </div>
  );
};
