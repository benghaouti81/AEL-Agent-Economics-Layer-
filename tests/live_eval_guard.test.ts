/**
 * Unit Tests: Live Evaluation Credentials & Spending Guard (C-2)
 * @license Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it('reports verifier/judge costs separately from product costs as disclosed verification_cost (P0-20)', async () => {
    const origAllowMock = process.env.AEL_ALLOW_MOCK;
    process.env.AEL_ALLOW_MOCK = '1';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const dbPath = path.join(os.tmpdir(), `ael_verif_cost_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

    const origWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).includes('_budget_tuning.json')) return;
      return origWriteFileSync(file, data as string | NodeJS.ArrayBufferView, options);
    });

    try {
      const result = await runBudgetEvalSuite(store, 'tuning');
      expect(typeof result.verification_cost).toBe('number');
      expect(result.verification_cost).toBeGreaterThan(0);

      const factualMetric = result.categories.factual;
      const mathMetric = result.categories.math;
      expect(factualMetric.verification_cost).toBeGreaterThan(0);
      expect(mathMetric.verification_cost).toBe(0);

      // Sum of category verification_cost equals disclosed top-level verification_cost
      const catVerifSum = Object.values(result.categories).reduce((s, c) => s + c.verification_cost, 0);
      expect(result.verification_cost).toBeCloseTo(catVerifSum, 5);

      // Net product savings excludes verification_cost
      const catProductNetSum = Object.values(result.categories).reduce(
        (s, c) => s + (c.baseline_cost_usd - c.actual_cost_usd),
        0
      );
      expect(result.overall_net_savings_usd).toBeCloseTo(catProductNetSum, 4);
    } finally {
      writeSpy.mockRestore();
      if (origAllowMock === undefined) delete process.env.AEL_ALLOW_MOCK;
      else process.env.AEL_ALLOW_MOCK = origAllowMock;
      store.close();
    }
  });

  it('caps tasks per category with limit and records model + sample_size explicitly in eval results (P0-21)', async () => {
    const origAllowMock = process.env.AEL_ALLOW_MOCK;
    process.env.AEL_ALLOW_MOCK = '1';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const dbPath = path.join(os.tmpdir(), `ael_limit_test_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

    // Prevent test from overwriting committed held_out / tool result files on disk
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      const f = String(file);
      if (f.includes('_budget_held_out.json') || f.includes('_tool_selection.json')) return;
      return origWriteFileSync(file, data as string | NodeJS.ArrayBufferView, options);
    });

    try {
      const flashLiteProfile = buildLiveGeminiBudgetProfile('gemini-2.5-flash-lite');
      expect(flashLiteProfile.default_model).toBe('gemini-2.5-flash-lite');

      const limitedProj = projectBudgetEvalCost('held_out', flashLiteProfile, 5);
      const fullProj = projectBudgetEvalCost('held_out', flashLiteProfile);
      expect(limitedProj.queryCount).toBe(20);
      expect(fullProj.queryCount).toBe(200);
      expect(limitedProj.projectedCostUsd).toBeLessThan(fullProj.projectedCostUsd);
      expect(limitedProj.projectedCostUsd).toBeLessThan(MAX_LIVE_EVAL_COST_USD);

      const limitedToolProj = projectToolEvalCost(buildLiveGeminiToolProfile('gemini-2.5-flash-lite'), 5);
      expect(limitedToolProj.queryCount).toBe(5);

      const budgetRes = await runBudgetEvalSuite(store, 'held_out', {
        limit: 5,
        model: 'gemini-2.5-flash-lite',
      });
      expect(budgetRes.model).toBe('gemini-2.5-flash-lite');
      expect(budgetRes.total_queries).toBe(20);
      expect(budgetRes.sample_size).toEqual({
        total_queries: 20,
        per_category: { factual: 5, math: 5, code: 5, extraction: 5 },
        limit_per_category: 5,
        full_dataset_queries: 200,
      });
      expect(budgetRes.run_command).toContain('--limit 5');
      expect(budgetRes.run_command).toContain('--model gemini-2.5-flash-lite');

      const toolRes = await runToolEvalSuite(store, {
        limit: 5,
        model: 'gemini-2.5-flash-lite',
      });
      expect(toolRes.model).toBe('gemini-2.5-flash-lite');
      expect(toolRes.selection_cases_total).toBe(5);
      expect(toolRes.dry_run_catch_cases_total).toBe(3);
      expect(toolRes.total_cases).toBe(8);
      expect(toolRes.sample_size).toEqual({
        selection_cases: 5,
        dry_run_catch_cases: 3,
        total_cases: 8,
        limit_per_category: 5,
        full_selection_cases: 10,
      });
      expect(toolRes.run_command).toContain('--limit 5');
      expect(toolRes.run_command).toContain('--model gemini-2.5-flash-lite');
    } finally {
      writeSpy.mockRestore();
      if (origAllowMock === undefined) delete process.env.AEL_ALLOW_MOCK;
      else process.env.AEL_ALLOW_MOCK = origAllowMock;
      store.close();
    }
  });
});
