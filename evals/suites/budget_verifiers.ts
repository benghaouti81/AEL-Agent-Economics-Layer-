/**
 * AEL — Real Per-Category Verification for Thinking Budget Evaluation Suite (P0-9)
 * - math: numeric match (exact / tolerance)
 * - code: TypeScript/JavaScript compilation via esbuild + isolated node:vm execution & assertions
 * - extraction: JSON parsing & expected field matching
 * - reasoning/factual: LLM judge verdict against reference answer (never accepts empty/boilerplate)
 * @license Apache-2.0
 */

import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { LLMClient } from '../../src/llm/client.js';

export type VerificationMethod = 'numeric_match' | 'code_execution' | 'json_field_match' | 'judge_verdict';

export interface VerificationResult {
  passed: boolean;
  method: VerificationMethod;
  detail: string;
}

/**
 * Extracts numeric candidates from an LLM response and compares against expected numeric ground truth.
 */
export function verifyMathNumericMatch(
  responseText: string,
  expectedNumber: number,
  tolerance: number = 0.01
): VerificationResult {
  if (!responseText || !responseText.trim()) {
    return { passed: false, method: 'numeric_match', detail: 'Empty response' };
  }

  // Prefer boxed or explicitly highlighted final answers if present
  const boxedMatch = responseText.match(/\\boxed\{([^}]+)\}/);
  const searchRegion = boxedMatch ? boxedMatch[1] : responseText;

  // Match integers, decimals, scientific notation, and fractions (e.g. 3/4)
  const fractionMatches = Array.from(searchRegion.matchAll(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g));
  const candidates: number[] = [];

  for (const fm of fractionMatches) {
    const num = Number(fm[1]);
    const den = Number(fm[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      candidates.push(num / den);
    }
  }

  const cleaned = searchRegion.replace(/(\d),(\d{3})\b/g, '$1$2');
  const numMatches = cleaned.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || [];
  for (const raw of numMatches) {
    const val = Number(raw);
    if (Number.isFinite(val)) {
      candidates.push(val);
    }
  }

  if (candidates.length === 0) {
    return { passed: false, method: 'numeric_match', detail: 'No numeric value found in response' };
  }

  // Check last few numbers first (final answer convention), then any candidate
  const effectiveTol = Number.isInteger(expectedNumber) ? Math.min(tolerance, 1e-6) : tolerance;
  const matched = candidates.some(v => Math.abs(v - expectedNumber) <= effectiveTol);

  return {
    passed: matched,
    method: 'numeric_match',
    detail: matched
      ? `Matched expected ${expectedNumber}`
      : `Expected ${expectedNumber} (±${effectiveTol}), got candidates [${candidates.slice(-5).join(', ')}]`,
  };
}

/**
 * Compiles TypeScript/JavaScript from response text using esbuild and runs assertions in an isolated vm context.
 */
export function verifyCodeAssertionExecution(
  responseText: string,
  functionName: string,
  assertionScript: string
): VerificationResult {
  if (!responseText || !responseText.trim()) {
    return { passed: false, method: 'code_execution', detail: 'Empty response' };
  }

  // Extract fenced code block if present, otherwise evaluate raw text
  const fenceMatch = responseText.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/i);
  let rawCode = fenceMatch ? fenceMatch[1] : responseText;

  // Strip ESM export keywords so function declarations bind cleanly into vm sandbox global
  rawCode = rawCode
    .replace(/^\s*import\s+[\s\S]*?;\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b|type\b|interface\b)/g, '');

  let jsCode: string;
  try {
    const transformed = esbuild.transformSync(rawCode, {
      loader: 'ts',
      target: 'es2022',
    });
    jsCode = transformed.code;
  } catch (err: any) {
    return {
      passed: false,
      method: 'code_execution',
      detail: `TypeScript/JS compile error: ${err?.message || String(err)}`,
    };
  }

  try {
    // Only inject Node's assert; keep VM-native intrinsics (Array, Map, Set, Date, Object)
    // so `new Array(...)` / `new Map()` share prototypes with literal expressions in assertions.
    const sandbox: Record<string, any> = {
      assert,
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(jsCode, context, { timeout: 200 });

    const fnCheck = vm.runInContext(`typeof ${functionName} === 'function'`, context, { timeout: 50 });
    if (!fnCheck) {
      return {
        passed: false,
        method: 'code_execution',
        detail: `Function '${functionName}' not defined after execution`,
      };
    }

    vm.runInContext(assertionScript, context, { timeout: 200 });
    return {
      passed: true,
      method: 'code_execution',
      detail: `All assertions passed for ${functionName}`,
    };
  } catch (err: any) {
    return {
      passed: false,
      method: 'code_execution',
      detail: `Runtime/assertion error for ${functionName}: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Extracts JSON from response text and validates all expected fields & values match.
 */
export function verifyExtractionJsonFields(
  responseText: string,
  expectedFields: Record<string, string | number | boolean>
): VerificationResult {
  if (!responseText || !responseText.trim()) {
    return { passed: false, method: 'json_field_match', detail: 'Empty response' };
  }

  const fenceMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
  const objMatch = candidate.match(/\{[\s\S]*\}/);

  if (!objMatch) {
    return { passed: false, method: 'json_field_match', detail: 'No JSON object found in response' };
  }

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch (err: any) {
    return {
      passed: false,
      method: 'json_field_match',
      detail: `Invalid JSON: ${err?.message || String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { passed: false, method: 'json_field_match', detail: 'Parsed JSON is not an object' };
  }

  const mismatches: string[] = [];
  for (const [key, expectedVal] of Object.entries(expectedFields)) {
    if (!(key in parsed)) {
      mismatches.push(`missing key '${key}'`);
      continue;
    }
    const actualVal = parsed[key];
    if (typeof expectedVal === 'number') {
      const actualNum = typeof actualVal === 'number' ? actualVal : Number(String(actualVal).replace(/[$,]/g, ''));
      if (!Number.isFinite(actualNum) || Math.abs(actualNum - expectedVal) > 0.01) {
        mismatches.push(`${key}: expected ${expectedVal}, got ${JSON.stringify(actualVal)}`);
      }
    } else if (typeof expectedVal === 'boolean') {
      if (actualVal !== expectedVal) {
        mismatches.push(`${key}: expected ${expectedVal}, got ${JSON.stringify(actualVal)}`);
      }
    } else {
      const normActual = String(actualVal ?? '').trim().toLowerCase();
      const normExpected = String(expectedVal).trim().toLowerCase();
      if (!normActual.includes(normExpected) && normActual !== normExpected) {
        mismatches.push(`${key}: expected '${expectedVal}', got '${String(actualVal)}'`);
      }
    }
  }

  if (mismatches.length > 0) {
    return {
      passed: false,
      method: 'json_field_match',
      detail: `Field mismatches: ${mismatches.join('; ')}`,
    };
  }

  return {
    passed: true,
    method: 'json_field_match',
    detail: `All ${Object.keys(expectedFields).length} JSON fields matched`,
  };
}

/**
 * Evaluates a reasoning/factual response using an explicit LLM judge verdict against a reference answer.
 * Rejects empty or mock placeholder answers rather than blindly counting non-empty text.
 */
export async function verifyReasoningJudgeVerdict(
  llm: LLMClient,
  query: string,
  referenceAnswer: string,
  candidateResponse: string
): Promise<{ result: VerificationResult; judgeCostUsd: number; judgeTokens: number }> {
  if (!candidateResponse || !candidateResponse.trim()) {
    return {
      result: { passed: false, method: 'judge_verdict', detail: 'Empty response' },
      judgeCostUsd: 0,
      judgeTokens: 0,
    };
  }

  const judgePrompt = [
    'VERIFY ANSWER CORRECTNESS:',
    `Question: ${query}`,
    `Expected Reference Fact/Answer: ${referenceAnswer}`,
    `Candidate Response: ${candidateResponse}`,
    'Does the Candidate Response accurately provide or entail the Expected Reference Fact/Answer without contradiction?',
    'Reply strictly with JSON: {"correct": true} or {"correct": false}.',
  ].join('\n');

  const judgeRes = await llm.complete(judgePrompt, { reasoning_effort: 'none' });

  let correct = false;
  try {
    const jsonMatch = judgeRes.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Strict boolean check: mock_simulator emits { verified: true } without { correct: true }, so mock does not forge factual accuracy.
      correct = parsed.correct === true;
    }
  } catch {
    correct = false;
  }

  return {
    result: {
      passed: correct,
      method: 'judge_verdict',
      detail: correct
        ? `Judge verdict: correct (ref '${referenceAnswer}')`
        : `Judge verdict: incorrect or unverified against '${referenceAnswer}'`,
    },
    judgeCostUsd: judgeRes.cost_usd,
    judgeTokens: judgeRes.total_tokens,
  };
}
