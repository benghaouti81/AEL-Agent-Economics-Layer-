/**
 * AEL — Real Per-Category Verification for Thinking Budget Evaluation Suite (P0-9)
 * - math: numeric match (exact / tolerance)
 * - code: TypeScript/JavaScript compilation via esbuild + separate Node child process with sanitized env ({}) & timeout (functional check only, NOT a container/kernel security sandbox)
 * - extraction: JSON parsing & expected field matching
 * - reasoning/factual: LLM judge verdict against reference answer (never accepts empty/boilerplate)
 * @license Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { LLMClient } from '../../src/llm/client.js';

export type VerificationMethod = 'numeric_match' | 'code_execution' | 'json_field_match' | 'judge_verdict';

export interface VerificationResult {
  passed: boolean;
  method: VerificationMethod;
  detail: string;
}

/**
 * Extracts ONLY the final numeric answer from an LLM response and compares it against
 * expected numeric ground truth. Intermediate numbers earlier in the derivation are ignored.
 */
export function verifyMathNumericMatch(
  responseText: string,
  expectedNumber: number,
  tolerance: number = 0.01
): VerificationResult {
  if (!responseText || !responseText.trim()) {
    return { passed: false, method: 'numeric_match', detail: 'Empty response' };
  }

  // 1. Prefer the LAST \boxed{...} expression if present; otherwise check the last explicit
  //    answer marker line; otherwise fall back to the full response text.
  const boxedMatches = Array.from(responseText.matchAll(/\\boxed\{([^{}]+)\}/g));
  let searchRegion: string;
  if (boxedMatches.length > 0) {
    searchRegion = boxedMatches[boxedMatches.length - 1][1];
  } else {
    const markerMatches = Array.from(
      responseText.matchAll(/(?:####|(?:final\s+answer|the\s+answer\s+is|answer\s+is|answer)\s*[:=]?)\s*([^\n]+)/gi)
    );
    searchRegion = markerMatches.length > 0
      ? markerMatches[markerMatches.length - 1][1]
      : responseText;
  }

  // 2. Normalize thousand-separator commas (e.g. 34,650 -> 34650, 1,234,567 -> 1234567)
  let cleaned = searchRegion;
  let prevCleaned = '';
  while (cleaned !== prevCleaned) {
    prevCleaned = cleaned;
    cleaned = cleaned.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  }

  // 3. Scan numeric tokens strictly left-to-right (fractions evaluated in place so 3/4 is one token 0.75)
  const tokenRegex = /(?<![\w.])(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)|(?<![\w.])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;
  const candidates: number[] = [];

  for (const match of cleaned.matchAll(tokenRegex)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      const num = Number(match[1]);
      const den = Number(match[2]);
      if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
        candidates.push(num / den);
      }
    } else if (match[3] !== undefined) {
      const val = Number(match[3]);
      if (Number.isFinite(val)) {
        candidates.push(val);
      }
    }
  }

  if (candidates.length === 0) {
    return { passed: false, method: 'numeric_match', detail: 'No numeric value found in final answer' };
  }

  // 4. Compare ONLY the final extracted numeric token against ground truth
  const finalValue = candidates[candidates.length - 1];
  const effectiveTol = Number.isInteger(expectedNumber) ? Math.min(tolerance, 1e-6) : tolerance;
  const matched = Math.abs(finalValue - expectedNumber) <= effectiveTol;

  return {
    passed: matched,
    method: 'numeric_match',
    detail: matched
      ? `Matched final answer ${finalValue} against expected ${expectedNumber}`
      : `Expected ${expectedNumber} (±${effectiveTol}), got final numeric answer ${finalValue}`,
  };
}

const DEFAULT_CODE_TIMEOUT_MS = 1500;
const DEFAULT_VM_TIMEOUT_MS = 250;

const CHILD_VERIFIER_RUNNER = [
  "const fs = require('node:fs');",
  "const vm = require('node:vm');",
  "const assert = require('node:assert/strict');",
  "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
  'const context = vm.createContext({ assert });',
  'vm.runInContext(payload.jsCode, context, { timeout: payload.vmTimeoutMs });',
  "const fnExists = vm.runInContext('typeof globalThis[' + JSON.stringify(payload.functionName) + \"] === 'function'\", context, { timeout: 50 });",
  'if (!fnExists) {',
  "  process.stderr.write(\"Function '\" + payload.functionName + \"' not defined after execution\");",
  '  process.exit(2);',
  '}',
  'vm.runInContext(payload.assertionScript, context, { timeout: payload.vmTimeoutMs });',
].join('\n');

/**
 * Compiles TypeScript/JavaScript from response text using esbuild and runs functional assertions
 * in a separate Node.js child process with a sanitized environment (`env: {}`) and hard timeouts.
 *
 * ISOLATION BOUNDARY (HONEST SCOPE):
 * - Isolated: Separate OS process address space & V8 isolate, empty environment (`env: {}`, zero
 *   parent API keys/tokens/secrets inherited), clean `node:vm` context globals, and bounded
 *   execution timeouts (inner `vm` CPU timeout + outer child process `SIGKILL` timeout).
 * - NOT isolated: Runs under the same OS user/UID and shares host filesystem/network/kernel
 *   capabilities. It is NOT a container, seccomp/AppArmor jail, or microVM security sandbox;
 *   adversarial untrusted code still requires container/VM-level isolation outside this harness.
 */
export function verifyCodeAssertionExecution(
  responseText: string,
  functionName: string,
  assertionScript: string,
  options: { timeoutMs?: number; vmTimeoutMs?: number } = {}
): VerificationResult {
  if (!responseText || !responseText.trim()) {
    return { passed: false, method: 'code_execution', detail: 'Empty response' };
  }

  // Extract fenced code block if present, otherwise evaluate raw text
  const fenceMatch = responseText.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/i);
  let rawCode = fenceMatch ? fenceMatch[1] : responseText;

  // Strip ESM export keywords so function declarations bind cleanly into the child vm context global
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;
  const vmTimeoutMs = options.vmTimeoutMs ?? Math.min(DEFAULT_VM_TIMEOUT_MS, timeoutMs);

  // Spawn child process with sanitized env ({}) so parent API keys & secrets are never inherited.
  const child = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '-e', CHILD_VERIFIER_RUNNER],
    {
      input: JSON.stringify({ jsCode, functionName, assertionScript, vmTimeoutMs }),
      env: {},
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
    }
  );

  if (child.error) {
    const errCode = (child.error as any).code;
    return {
      passed: false,
      method: 'code_execution',
      detail:
        errCode === 'ETIMEDOUT'
          ? `Execution timed out after ${timeoutMs}ms for ${functionName}`
          : `Child process error for ${functionName}: ${child.error.message}`,
    };
  }

  if (child.status !== 0) {
    const stderrMsg = (child.stderr || '').trim();
    return {
      passed: false,
      method: 'code_execution',
      detail: stderrMsg
        ? `Runtime/assertion error for ${functionName}: ${stderrMsg}`
        : `Child process exited with status ${child.status} (signal=${child.signal || 'none'}) for ${functionName}`,
    };
  }

  return {
    passed: true,
    method: 'code_execution',
    detail: `All assertions passed for ${functionName}`,
  };
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
