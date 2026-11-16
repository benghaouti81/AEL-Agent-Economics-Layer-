/**
 * Unit Tests: Live Evaluation Credentials, Spending Guard & Runner Integrity
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
  getProviderPricing,
  resolveLiveProviderProfile,
} from '../evals/suites/spending_guard.js';
import { buildLiveGeminiBudgetProfile, projectBudgetEvalCost, runBudgetEvalSuite } from '../evals/suites/budget_eval_suite.js';
import { buildLiveGeminiToolProfile, projectToolEvalCost, runToolEvalSuite } from '../evals/suites/tool_eval_suite.js';
import { validateBenchmarkResult } from '../evals/suites/benchmark_validator.js';

function createOpenAIEvalFetchStub() {
  return vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const prompt: string = body?.messages?.[0]?.content || '';
    const isHigh = body?.reasoning_effort === 'high';

    let content = 'Fallback response';
    if (prompt.includes('VERIFY ANSWER CORRECTNESS')) {
      content = JSON.stringify({ correct: true });
    } else if (prompt.includes('SELECT TOOL AND ARGUMENTS')) {
      const taskMatch = prompt.match(/for this user task:\s*\n?"([^"]+)"|SELECT TOOL AND ARGUMENTS:\s*"([^"]+)"/);
      const lower = (taskMatch ? (taskMatch[1] || taskMatch[2] || '') : prompt.split('\n').slice(0, 3).join(' ')).toLowerCase();
      if (lower.includes('sql') || lower.includes('select') || lower.includes('warehouse')) {
        content = JSON.stringify({ tool: 'db_query_readonly', arguments: { sql: 'SELECT 1' } });
      } else if (lower.includes('transfer') || lower.includes('$50')) {
        content = JSON.stringify({
          tool: 'fin_transfer_funds',
          arguments: { source_account: 'acc_001', target_account: 'acc_002', amount_usd: 50 },
        });
      } else if (lower.includes('list') || lower.includes('inspect files')) {
        content = JSON.stringify({ tool: 'fs_list_directory', arguments: { path: '/workspace' } });
      } else if (lower.includes('search') || lower.includes('find') || lower.includes('query documentation')) {
        content = JSON.stringify({ tool: 'search_knowledge_base', arguments: { query: 'economics layer' } });
      } else {
        content = JSON.stringify({ tool: 'fs_read_file', arguments: { path: '/workspace/README.md' } });
      }
    } else if (prompt.includes('Apollo 11')) {
      content = 'Apollo 11 landed on the Moon in 1969.';
    } else if (prompt.includes('distinct prime factors of 360')) {
      content = 'The distinct prime factors of 360 are 2, 3, and 5. \\boxed{10}';
    } else if (prompt.includes('reverseInPlace')) {
      content = [
        '```ts',
        'function reverseInPlace<T>(arr: T[]): T[] {',
        '  let l = 0, r = arr.length - 1;',
        '  while (l < r) { [arr[l], arr[r]] = [arr[r], arr[l]]; l++; r--; }',
        '  return arr;',
        '}',
        '```',
      ].join('\n');
    } else if (prompt.includes('Jane Doe')) {
      content = JSON.stringify({ name: 'Jane Doe', email: 'jane.doe@acme.io', phone: '+1-555-0192' });
    }

    const promptTokens = 40;
    const completionTokens = 30;
    const reasoningTokens = isHigh ? 450 : 20;

    return {
      ok: true,
      json: async () => ({
        model: body?.model || 'gpt-4o-mini',
        choices: [
          {
            message: { content },
            logprobs: { content: [{ logprob: -0.04 }] },
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens + reasoningTokens,
          completion_tokens_details: {
            reasoning_tokens: reasoningTokens,
          },
        },
      }),
    };
  });
}

describe('Live Evaluation Credentials & Spending Guard', () => {
  const origGeminiKey = process.env.GEMINI_API_KEY;
  const origOpenAIKey = process.env.OPENAI_API_KEY;
  const origAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const origLiveEval = process.env.AEL_LIVE_EVAL;
  const tmpDbs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    if (origGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGeminiKey;

    if (origOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origOpenAIKey;

    if (origAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origAnthropicKey;

    if (origLiveEval === undefined) delete process.env.AEL_LIVE_EVAL;
    else process.env.AEL_LIVE_EVAL = origLiveEval;

    for (const db of tmpDbs) {
      if (fs.existsSync(db)) fs.unlinkSync(db);
    }
    tmpDbs.length = 0;
  });

  it('requires valid live credentials and never falls back to simulation', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => assertValidGeminiKey(undefined)).toThrow(/GEMINI_API_KEY/);
    expect(() => assertValidGeminiKey('MY_GEMINI_API_KEY')).toThrow(/GEMINI_API_KEY/);
    expect(() => resolveLiveProviderProfile()).toThrow(/Missing live provider credentials/);

    const dbPath = path.join(os.tmpdir(), `ael_live_test_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

    await expect(runToolEvalSuite(store)).rejects.toThrow(/Missing live provider credentials/);
    await expect(runBudgetEvalSuite(store, 'held_out')).rejects.toThrow(/Missing live provider credentials/);
    store.close();
  });

  it('projects limited-sample and Flash-Lite live eval costs under $1.00 while aborting over-cap full runs under official Gemini pricing', () => {
    // Full 200q on gemini-2.5-flash-lite ($0.10/$0.40) stays well under $1.00
    const flashLiteToolProj = projectToolEvalCost(buildLiveGeminiToolProfile('gemini-2.5-flash-lite'));
    const flashLiteBudgetProj = projectBudgetEvalCost('held_out', buildLiveGeminiBudgetProfile('gemini-2.5-flash-lite'));
    const flashLiteCombined = flashLiteToolProj.projectedCostUsd + flashLiteBudgetProj.projectedCostUsd;
    expect(flashLiteCombined).toBeGreaterThan(0);
    expect(flashLiteCombined).toBeLessThan(MAX_LIVE_EVAL_COST_USD);
    expect(() => assertWithinSpendingGuard(flashLiteCombined, MAX_LIVE_EVAL_COST_USD, 'combined-flash-lite')).not.toThrow();

    // Workflow-default --limit 5 on gemini-3.5-flash-lite ($0.30/$2.50) stays well under $1.00
    const limitedDefaultTool = projectToolEvalCost(buildLiveGeminiToolProfile('gemini-3.5-flash-lite'), 5);
    const limitedDefaultBudget = projectBudgetEvalCost('held_out', buildLiveGeminiBudgetProfile('gemini-3.5-flash-lite'), 5);
    const limitedDefaultCombined = limitedDefaultTool.projectedCostUsd + limitedDefaultBudget.projectedCostUsd;
    expect(limitedDefaultCombined).toBeGreaterThan(0);
    expect(limitedDefaultCombined).toBeLessThan(MAX_LIVE_EVAL_COST_USD);
    expect(() => assertWithinSpendingGuard(limitedDefaultCombined, MAX_LIVE_EVAL_COST_USD, 'combined-limit-5')).not.toThrow();

    // Full 200q on gemini-2.5-flash at official $0.30/$2.50 rates exceeds $1.00 and aborts unless capped via --limit
    const full25FlashBudget = projectBudgetEvalCost('held_out', buildLiveGeminiBudgetProfile('gemini-2.5-flash'));
    expect(full25FlashBudget.projectedCostUsd).toBeGreaterThan(MAX_LIVE_EVAL_COST_USD);
    expect(() => assertWithinSpendingGuard(full25FlashBudget.projectedCostUsd, MAX_LIVE_EVAL_COST_USD, 'full-25-flash')).toThrow(
      /Spending Guard ABORT/
    );

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
      runBudgetEvalSuite(store, 'held_out', { provider: 'gemini', maxCostUsd: 0.01 })
    ).rejects.toThrow(/Spending Guard ABORT/);

    await expect(
      runToolEvalSuite(store, { provider: 'gemini', maxCostUsd: 0.001 })
    ).rejects.toThrow(/Spending Guard ABORT/);

    store.close();
  });

  it('reports verifier/judge costs separately from product costs as disclosed verification_cost using provider-reported tokens (P0-20)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-guard-valid-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    vi.stubGlobal('fetch', createOpenAIEvalFetchStub());

    const dbPath = path.join(os.tmpdir(), `ael_verif_cost_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

    const origWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).includes('_budget_tuning.json')) return;
      return origWriteFileSync(file, data as string | NodeJS.ArrayBufferView, options);
    });

    try {
      const result = await runBudgetEvalSuite(store, 'tuning', { provider: 'openai' });
      expect(result.source).toBe('live_provider');
      expect(result.provider).toBe('openai');
      expect(result.credential_status).toBe('live_credentials_present');
      expect(result.savings_claims_valid).toBe(true);
      expect(typeof result.verification_cost).toBe('number');
      expect(result.verification_cost).toBeGreaterThan(0);

      const factualMetric = result.categories.factual;
      const mathMetric = result.categories.math;
      expect(factualMetric.verification_cost).toBeGreaterThan(0);
      expect(mathMetric.verification_cost).toBe(0);

      const catVerifSum = Object.values(result.categories).reduce((s, c) => s + c.verification_cost, 0);
      expect(result.verification_cost).toBeCloseTo(catVerifSum, 5);

      const catProductNetSum = Object.values(result.categories).reduce(
        (s, c) => s + (c.baseline_cost_usd - c.actual_cost_usd),
        0
      );
      expect(result.overall_net_savings_usd).toBeCloseTo(catProductNetSum, 4);
    } finally {
      writeSpy.mockRestore();
      store.close();
    }
  });

  it('caps tasks per category with limit and records model + sample_size + full provenance explicitly in live eval results (P0-21)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-guard-valid-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    vi.stubGlobal('fetch', createOpenAIEvalFetchStub());

    const dbPath = path.join(os.tmpdir(), `ael_limit_test_${Date.now()}.db`);
    tmpDbs.push(dbPath);
    const store = new DecisionLogStore(dbPath);

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
        provider: 'openai',
        limit: 1,
        model: 'gpt-4o-mini',
      });
      expect(budgetRes.source).toBe('live_provider');
      expect(budgetRes.model).toBe('gpt-4o-mini');
      expect(budgetRes.total_queries).toBe(4);
      expect(budgetRes.sample_size).toEqual({
        total_queries: 4,
        valid_samples: 4,
        per_category: { factual: 1, math: 1, code: 1, extraction: 1 },
        limit_per_category: 1,
        full_dataset_queries: 200,
      });
      expect(budgetRes.run_command).toContain('--provider openai');
      expect(budgetRes.run_command).toContain('--limit 1');
      expect(budgetRes.run_command).toContain('--model gpt-4o-mini');
      expect(validateBenchmarkResult(budgetRes).valid).toBe(true);

      const toolRes = await runToolEvalSuite(store, {
        provider: 'openai',
        limit: 5,
        model: 'gpt-4o-mini',
      });
      expect(toolRes.source).toBe('live_provider');
      expect(toolRes.model).toBe('gpt-4o-mini');
      expect(toolRes.selection_cases_total).toBe(5);
      expect(toolRes.dry_run_catch_cases_total).toBe(3);
      expect(toolRes.total_cases).toBe(8);
      expect(toolRes.sample_size).toEqual({
        selection_cases: 5,
        dry_run_catch_cases: 3,
        total_cases: 8,
        valid_samples: 8,
        limit_per_category: 5,
        full_selection_cases: 10,
      });
      expect(toolRes.run_command).toContain('--provider openai');
      expect(toolRes.run_command).toContain('--limit 5');
      expect(toolRes.run_command).toContain('--model gpt-4o-mini');
      expect(validateBenchmarkResult(toolRes).valid).toBe(true);
    } finally {
      writeSpy.mockRestore();
      store.close();
    }
  });

  it('verifies every Gemini model referenced in live-eval.yml defaults exists in PROVIDER_PRICING_CATALOG (P0-22)', () => {
    const workflowPath = path.resolve(process.cwd(), '.github/workflows/live-eval.yml');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');

    const inputDefaultMatch = workflowText.match(/default:\s*'([^']+)'/);
    const envFallbackMatch = workflowText.match(/EVAL_MODEL:\s*\$\{\{\s*inputs\.model\s*\|\|\s*'([^']+)'\s*\}\}/);

    expect(inputDefaultMatch).not.toBeNull();
    expect(envFallbackMatch).not.toBeNull();

    const referencedDefaults = Array.from(
      new Set([inputDefaultMatch![1].trim(), envFallbackMatch![1].trim()])
    );
    expect(referencedDefaults).toEqual(['gemini-3.5-flash-lite']);

    for (const modelId of referencedDefaults) {
      const pricing = getProviderPricing('gemini', modelId);
      expect(pricing.model).toBe(modelId);
      expect(pricing.input).toBeGreaterThan(0);
      expect(pricing.output).toBeGreaterThan(0);
    }
  });
});
