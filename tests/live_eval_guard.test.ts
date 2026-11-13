/**
 * Unit Tests: Live Evaluation Credentials & Spending Guard (C-2)
 * @license Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DecisionLogStore } from '../src/db/decision_log.js';
import {
  MAX_LIVE_EVAL_COST_USD,
  assertValidGeminiKey,
  assertWithinSpendingGuard,
  estimateProjectedEvalCost,
} from '../evals/suites/spending_guard.js';
import { buildLiveGeminiBudgetProfile, projectBudgetEvalCost, runBudgetEvalSuite } from '../evals/suites/budget_eval_suite.js';
import { buildLiveGeminiToolProfile, projectToolEvalCost, runToolEvalSuite } from '../evals/suites/tool_eval_suite.js';

describe('Live Evaluation Credentials & Spending Guard', () => {
  const origGeminiKey = process.env.GEMINI_API_KEY;
  const origLiveEval = process.env.AEL_LIVE_EVAL;
  const tmpDbs: string[] = [];

  afterEach(() => {
    if (origGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGeminiKey;

    if (origLiveEval === undefined) delete process.env.AEL_LIVE_EVAL;
    else process.env.AEL_LIVE_EVAL = origLiveEval;

    for (const db of tmpDbs) {
      if (fs.existsSync(db)) fs.unlinkSync(db);
    }
    tmpDbs.length = 0;
  });

  it('requires a non-placeholder GEMINI_API_KEY in live mode and never falls back to mock', async () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => assertValidGeminiKey(undefined)).toThrow(/GEMINI_API_KEY/);
    expect(() => assertValidGeminiKey('MY_GEMINI_API_KEY')).toThrow(/GEMINI_API_KEY/);

    const dbPath = path.join(os.tmpdir(), `ael_live_test_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

    await expect(runToolEvalSuite(store, { live: true })).rejects.toThrow(/GEMINI_API_KEY/);
    await expect(runBudgetEvalSuite(store, 'held_out', { live: true })).rejects.toThrow(/GEMINI_API_KEY/);
    store.close();
  });

  it('projects Gemini 2.5 Flash combined live eval cost under $1.00 and aborts when projected cost > cap', () => {
    const toolProj = projectToolEvalCost(buildLiveGeminiToolProfile());
    const budgetProj = projectBudgetEvalCost('held_out', buildLiveGeminiBudgetProfile());
    const combinedCost = toolProj.projectedCostUsd + budgetProj.projectedCostUsd;

    expect(combinedCost).toBeGreaterThan(0);
    expect(combinedCost).toBeLessThan(MAX_LIVE_EVAL_COST_USD);
    expect(() => assertWithinSpendingGuard(combinedCost, MAX_LIVE_EVAL_COST_USD, 'combined')).not.toThrow();

    // Expensive pricing profile must trigger spending guard abort (> $1.00)
    const expensiveProj = estimateProjectedEvalCost({
      queries: Array.from({ length: 200 }, (_, i) => `Complex query ${i}`),
      promptOverheadCharsPerCall: 200,
      callsPerQuery: 2,
      estimatedOutputTokensPerCall: 500,
      estimatedReasoningTokensPerCall: 1000,
      provider: {
        ...buildLiveGeminiBudgetProfile(),
        input_cost_per_million: 5.0,
        output_cost_per_million: 15.0,
        reasoning_cost_per_million: 15.0,
      },
    });
    expect(expensiveProj.projectedCostUsd).toBeGreaterThan(MAX_LIVE_EVAL_COST_USD);
    expect(() => assertWithinSpendingGuard(expensiveProj.projectedCostUsd, MAX_LIVE_EVAL_COST_USD, 'expensive')).toThrow(/Spending Guard ABORT/);
  });

  it('aborts suite execution before making calls if maxCostUsd cap is below projected cost', async () => {
    process.env.GEMINI_API_KEY = 'AIza-fake-key-for-preflight-test';
    const dbPath = path.join(os.tmpdir(), `ael_guard_abort_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

    await expect(
      runBudgetEvalSuite(store, 'held_out', { live: true, maxCostUsd: 0.01 })
    ).rejects.toThrow(/Spending Guard ABORT/);

    await expect(
      runToolEvalSuite(store, { live: true, maxCostUsd: 0.001 })
    ).rejects.toThrow(/Spending Guard ABORT/);

    store.close();
  });
});
