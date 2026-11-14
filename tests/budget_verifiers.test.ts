/**
 * Unit Tests: Per-Category Real Verifiers for Thinking Budget Eval Suite (P0-9)
 * @license Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as esbuild from 'esbuild';
import {
  verifyCodeAssertionExecution,
  verifyExtractionJsonFields,
  verifyMathNumericMatch,
  verifyReasoningJudgeVerdict,
} from '../evals/suites/budget_verifiers.js';
import { DISTINCT_BUDGET_QUERIES } from '../evals/suites/budget_eval_suite.js';
import { LLMClient } from '../src/llm/client.js';

describe('Budget Eval Per-Category Real Verifiers (P0-9)', () => {
  const originalAllowMock = process.env.AEL_ALLOW_MOCK;

  beforeEach(() => {
    process.env.AEL_ALLOW_MOCK = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAllowMock === undefined) delete process.env.AEL_ALLOW_MOCK;
    else process.env.AEL_ALLOW_MOCK = originalAllowMock;
  });

  it('verifies math responses via numeric match and rejects mock boilerplate', () => {
    expect(verifyMathNumericMatch('The remainder is \\boxed{4}.', 4).passed).toBe(true);
    expect(verifyMathNumericMatch('The tip is $12.69.', 12.69, 0.01).passed).toBe(true);
    expect(verifyMathNumericMatch('34,650 distinct permutations.', 34650).passed).toBe(true);
    expect(verifyMathNumericMatch('The answer is 42.', 4).passed).toBe(false);
    expect(verifyMathNumericMatch('Processed response for query. Verified output.', 4).passed).toBe(false);
  });

  it('verifies code responses by compiling TypeScript via esbuild and executing assertions in node:vm', () => {
    const validTs = [
      '```ts',
      'export function reverseInPlace<T>(arr: T[]): T[] {',
      '  let l = 0, r = arr.length - 1;',
      '  while (l < r) { [arr[l], arr[r]] = [arr[r], arr[l]]; l++; r--; }',
      '  return arr;',
      '}',
      '```',
    ].join('\n');

    const assertion = 'const a=[1,2,3]; assert.strictEqual(reverseInPlace(a), a); assert.deepStrictEqual(a, [3,2,1]);';
    expect(verifyCodeAssertionExecution(validTs, 'reverseInPlace', assertion).passed).toBe(true);

    const buggyTs = 'function reverseInPlace(arr: number[]) { return arr; }';
    expect(verifyCodeAssertionExecution(buggyTs, 'reverseInPlace', assertion).passed).toBe(false);
    expect(verifyCodeAssertionExecution('Processed response for query. Verified output.', 'reverseInPlace', assertion).passed).toBe(false);
  });

  it('verifies extraction responses via JSON parsing and field matching', () => {
    const validJson = '```json\n{"name": "Jane Doe", "email": "jane.doe@acme.io", "phone": "+1-555-0192"}\n```';
    const expected = { name: 'Jane Doe', email: 'jane.doe@acme.io', phone: '+1-555-0192' };

    expect(verifyExtractionJsonFields(validJson, expected).passed).toBe(true);
    expect(verifyExtractionJsonFields('{"name": "Wrong Person", "email": "jane.doe@acme.io", "phone": "+1-555-0192"}', expected).passed).toBe(false);
    expect(verifyExtractionJsonFields('Processed response for query. Verified output.', expected).passed).toBe(false);
  });

  it('verifies reasoning/factual responses via LLM judge verdict and never trusts mock boilerplate', async () => {
    const mockLlm = new LLMClient({
      name: 'mock',
      type: 'mock',
      api_key_env: 'GEMINI_API_KEY',
      default_model: 'mock',
      cheap_model: 'mock',
      reasoning_model: 'mock',
      supports_reasoning_effort: true,
      supports_logprobs: false,
      input_cost_per_million: 0.1,
      output_cost_per_million: 0.4,
      reasoning_cost_per_million: 0.4,
    });

    // Under mock_simulator, VERIFY returns { verified: true } without { correct: true } -> must NOT count as passed
    const mockJudgeOut = await verifyReasoningJudgeVerdict(mockLlm, 'What year?', '1969', 'Processed response for query. Verified output.');
    expect(mockJudgeOut.result.passed).toBe(false);

    // With real judge JSON verdict {"correct": true}
    vi.spyOn(mockLlm, 'complete').mockResolvedValueOnce({
      text: '{"correct": true}',
      input_tokens: 20,
      output_tokens: 5,
      reasoning_tokens: 0,
      total_tokens: 25,
      cost_usd: 0.00001,
      latency_ms: 10,
      model: 'mock',
      confidence_source: 'unavailable',
      provider_source: 'gemini',
    });
    const passJudgeOut = await verifyReasoningJudgeVerdict(mockLlm, 'What year?', '1969', 'Apollo 11 landed in 1969.');
    expect(passJudgeOut.result.passed).toBe(true);
  });
});

describe('Budget Eval Dataset Integrity (P0-9)', () => {
  it('contains 50 distinct verifiable queries in every category (200 total)', () => {
    expect(DISTINCT_BUDGET_QUERIES.factual).toHaveLength(50);
    expect(DISTINCT_BUDGET_QUERIES.math).toHaveLength(50);
    expect(DISTINCT_BUDGET_QUERIES.code).toHaveLength(50);
    expect(DISTINCT_BUDGET_QUERIES.extraction).toHaveLength(50);

    const allIds = new Set<string>();
    const allQueries = new Set<string>();

    for (const q of Object.values(DISTINCT_BUDGET_QUERIES).flat()) {
      expect(allIds.has(q.id)).toBe(false);
      expect(allQueries.has(q.query)).toBe(false);
      allIds.add(q.id);
      allQueries.add(q.query);
    }

    for (const q of DISTINCT_BUDGET_QUERIES.math) {
      expect(typeof q.expected_number).toBe('number');
    }
    for (const q of DISTINCT_BUDGET_QUERIES.code) {
      expect(q.function_name).toBeTruthy();
      expect(q.assertion_script).toBeTruthy();
      expect(() =>
        esbuild.transformSync(q.assertion_script!, { loader: 'ts', target: 'es2022' })
      ).not.toThrow();
    }
    for (const q of DISTINCT_BUDGET_QUERIES.extraction) {
      expect(q.expected_json && Object.keys(q.expected_json).length).toBeGreaterThanOrEqual(3);
    }
  });
});

