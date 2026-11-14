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
      expect(Number.isFinite(q.expected_number)).toBe(true);
    }
    const m7 = DISTINCT_BUDGET_QUERIES.math.find(m => m.id === 'm_7');
    const m19 = DISTINCT_BUDGET_QUERIES.math.find(m => m.id === 'm_19');
    expect(m7?.expected_number).toBe(-7);
    expect(m19?.expected_number).toBe(146);

    for (const q of DISTINCT_BUDGET_QUERIES.code) {
      expect(q.function_name).toBeTruthy();
      expect(q.assertion_script).toBeTruthy();
      expect(() =>
        esbuild.transformSync(q.assertion_script!, { loader: 'js', target: 'es2022' })
      ).not.toThrow();
    }
    for (const q of DISTINCT_BUDGET_QUERIES.extraction) {
      expect(q.expected_json && Object.keys(q.expected_json).length).toBeGreaterThanOrEqual(3);
      const roundTrip = verifyExtractionJsonFields(JSON.stringify(q.expected_json), q.expected_json!);
      expect(roundTrip.passed).toBe(true);
    }
  });

  it('executes all 50 code assertion scripts cleanly against reference implementations in node:vm (P0-13)', () => {
    const referenceImpls: Record<string, string> = {
      c_1: 'function reverseInPlace<T>(arr: T[]): T[] { let l=0, r=arr.length-1; while(l<r){ [arr[l],arr[r]]=[arr[r],arr[l]]; l++; r--; } return arr; }',
      c_2: 'function truncateText(text: string, maxLen: number): string { if(text.length<=maxLen) return text; if(maxLen<=3) return text.slice(0,maxLen); return text.slice(0, maxLen-3)+"..."; }',
      c_3: 'function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }',
      c_4: 'function chunkArray<T>(arr: T[], size: number): T[][] { const out: T[][]=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }',
      c_5: 'function createRingBuffer(capacity: number) { const buf: number[]=[]; return { push(v: number){ if(buf.length>=capacity) return false; buf.push(v); return true; }, pop(){ return buf.shift(); } }; }',
      c_6: 'function topoSort(nodes: string[], edges: Array<[string,string]>): string[]|null { const adj = new Map<string,string[]>(nodes.map(n=>[n,[]])); const indeg = new Map<string,number>(nodes.map(n=>[n,0])); for(const [u,v] of edges){ adj.get(u)!.push(v); indeg.set(v,(indeg.get(v)||0)+1); } const q = nodes.filter(n=>indeg.get(n)===0); const res: string[]=[]; while(q.length){ const u=q.shift()!; res.push(u); for(const v of adj.get(u)!){ indeg.set(v, indeg.get(v)!-1); if(indeg.get(v)===0) q.push(v); } } return res.length===nodes.length ? res : null; }',
      c_7: 'function createLRUCache<K,V>(capacity: number) { const m = new Map<K,V>(); return { get(k:K){ if(!m.has(k)) return undefined; const v=m.get(k)!; m.delete(k); m.set(k,v); return v; }, put(k:K,v:V){ if(m.has(k)) m.delete(k); else if(m.size>=capacity) m.delete(m.keys().next().value!); m.set(k,v); } }; }',
      c_8: 'function createMinHeap() { const a:number[]=[]; return { push(n:number){ a.push(n); a.sort((x,y)=>x-y); }, pop(){ return a.shift(); }, peek(){ return a[0]; }, size(){ return a.length; } }; }',
      c_9: 'function groupBy<T>(items: T[], keyFn: (item: T)=>string): Record<string,T[]> { const r: Record<string,T[]>={}; for(const it of items){ const k=keyFn(it); (r[k] ||= []).push(it); } return r; }',
      c_10: 'function deepClone<T>(val: T, seen = new WeakMap()): T { if(val===null || typeof val!=="object") return val; if(val instanceof Date) return new Date(val.getTime()) as any; if(seen.has(val as any)) return seen.get(val as any); const out: any = Array.isArray(val) ? [] : {}; seen.set(val as any, out); for(const k of Object.keys(val as any)) out[k] = deepClone((val as any)[k], seen); return out; }',
      c_11: 'function createTrie() { const root: any = { end: false, children: {} }; return { insert(w:string){ let cur=root; for(const ch of w) cur = (cur.children[ch] ||= {end:false, children:{}}); cur.end=true; }, search(w:string){ let cur=root; for(const ch of w){ if(!cur.children[ch]) return false; cur=cur.children[ch]; } return cur.end; }, startsWith(p:string){ let cur=root; for(const ch of p){ if(!cur.children[ch]) return false; cur=cur.children[ch]; } return true; } }; }',
      c_12: 'function createEmitter() { const m = new Map<string, Set<Function>>(); return { on(ev:string, fn:Function){ if(!m.has(ev)) m.set(ev, new Set()); m.get(ev)!.add(fn); }, off(ev:string, fn:Function){ m.get(ev)?.delete(fn); }, emit(ev:string, ...args:any[]){ m.get(ev)?.forEach(fn=>fn(...args)); } }; }',
      c_13: 'function mergeIntervals(intervals: Array<[number,number]>): Array<[number,number]> { const s=[...intervals].sort((a,b)=>a[0]-b[0]); const out: Array<[number,number]>=[]; for(const iv of s){ if(!out.length || out[out.length-1][1]<iv[0]) out.push([...iv]); else out[out.length-1][1]=Math.max(out[out.length-1][1], iv[1]); } return out; }',
      c_14: 'function createTokenBucket(capacity: number, refillPerSec: number) { let tokens=capacity, last=0; return { consume(req:number, nowSec:number){ tokens = Math.min(capacity, tokens + (nowSec - last)*refillPerSec); last = nowSec; if(tokens >= req){ tokens -= req; return true; } return false; } }; }',
      c_15: 'function flattenObject(obj: Record<string, any>, prefix = ""): Record<string, any> { const res: Record<string, any>={}; for(const [k,v] of Object.entries(obj)){ const nk = prefix ? prefix+"."+k : k; if(v && typeof v==="object" && !Array.isArray(v)) Object.assign(res, flattenObject(v, nk)); else res[nk]=v; } return res; }',
      c_16: 'function searchRotated(nums: number[], target: number): number { let l=0, r=nums.length-1; while(l<=r){ const m=(l+r)>>1; if(nums[m]===target) return m; if(nums[l]<=nums[m]){ if(target>=nums[l] && target<nums[m]) r=m-1; else l=m+1; } else { if(target>nums[m] && target<=nums[r]) l=m+1; else r=m-1; } } return -1; }',
      c_17: 'function isValidBrackets(s: string): boolean { const st:string[]=[]; const pairs:Record<string,string>={")":"(","]":"[","}":"{"}; for(const c of s){ if("([{".includes(c)) st.push(c); else if(st.pop()!==pairs[c]) return false; } return st.length===0; }',
      c_18: 'function createFSM(initial: string, transitions: Record<string, Record<string,string>>) { let st=initial; return { state(){ return st; }, send(ev:string){ st = transitions[st]?.[ev] ?? st; return st; } }; }',
      c_19: 'function memoize<A extends any[], R>(fn: (...args: A)=>R): (...args: A)=>R { const cache = new Map<string, R>(); return (...args: A)=>{ const k=JSON.stringify(args); if(cache.has(k)) return cache.get(k)!; const v=fn(...args); cache.set(k,v); return v; }; }',
      c_20: 'function quickselect(nums: number[], k: number): number { return [...nums].sort((a,b)=>a-b)[k]; }',
      c_21: 'function createCounterBreaker(threshold: number) { let fails=0; return { recordFailure(){ fails++; }, recordSuccess(){ fails=0; }, state(): "CLOSED"|"OPEN" { return fails>=threshold ? "OPEN" : "CLOSED"; } }; }',
      c_22: 'function topKFrequent(nums: number[], k: number): number[] { const c = new Map<number,number>(); for(const n of nums) c.set(n,(c.get(n)||0)+1); return [...c.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(x=>x[0]); }',
      c_23: 'function lcsLength(a: string, b: string): number { const dp = Array.from({length:a.length+1}, ()=>new Array(b.length+1).fill(0)); for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]); return dp[a.length][b.length]; }',
      c_24: 'function levenshtein(a: string, b: string): number { const dp = Array.from({length:a.length+1}, (_,i)=>Array.from({length:b.length+1}, (_,j)=>i===0?j:j===0?i:0)); for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) dp[i][j] = a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]); return dp[a.length][b.length]; }',
      c_25: 'function encodeVarint(n: number): number[] { const out:number[]=[]; do { let b=n&0x7f; n>>>=7; if(n>0) b|=0x80; out.push(b); } while(n>0); return out; }',
      c_26: 'function shortestGridPath(grid: number[][]): number { const R=grid.length, C=grid[0].length; if(grid[0][0]===1 || grid[R-1][C-1]===1) return -1; const q: Array<[number,number,number]>=[[0,0,0]]; const vis=new Set(["0,0"]); while(q.length){ const [r,c,d]=q.shift()!; if(r===R-1 && c===C-1) return d; for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]){ const nr=r+dr,nc=c+dc; if(nr>=0&&nr<R&&nc>=0&&nc<C&&grid[nr][nc]===0&&!vis.has(nr+","+nc)){ vis.add(nr+","+nc); q.push([nr,nc,d+1]); } } } return -1; }',
      c_27: 'function serializeLevelOrder(root: { val: number; left?: any; right?: any } | null): (number | null)[] { if(!root) return []; const q:any[]=[root]; const out:(number|null)[]=[]; while(q.length){ const n=q.shift(); if(n){ out.push(n.val); q.push(n.left??null, n.right??null); } else out.push(null); } while(out.length && out[out.length-1]===null) out.pop(); return out; }',
      c_28: 'function pipe<T>(...fns: Array<(x:T)=>T>): (x:T)=>T { return (x:T)=>fns.reduce((v,f)=>f(v), x); }',
      c_29: 'function camelToSnake(s: string): string { return s.replace(/([A-Z])/g, (m,p,off)=> (off>0?"_":"")+m.toLowerCase()); }',
      c_30: 'function mergeSortedLists(a: number[], b: number[]): number[] { const out:number[]=[]; let i=0,j=0; while(i<a.length && j<b.length) out.push(a[i]<=b[j]?a[i++]:b[j++]); return out.concat(a.slice(i), b.slice(j)); }',
      c_31: 'function arrayDiff(a: number[], b: number[]): {added:number[]; removed:number[]} { const sa=new Set(a), sb=new Set(b); return { added: [...sb].filter(x=>!sa.has(x)), removed: [...sa].filter(x=>!sb.has(x)) }; }',
      c_32: 'function fnv1aHash(str: string): number { let h=2166136261; for(let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }',
      c_33: 'function uniqueValues<T>(arr: T[]): T[] { return [...new Set(arr)]; }',
      c_34: 'function maxSlidingWindow(nums: number[], k: number): number[] { const out:number[]=[]; for(let i=0;i<=nums.length-k;i++) out.push(Math.max(...nums.slice(i,i+k))); return out; }',
      c_35: 'function parseCsvLine(line: string): string[] { const out:string[]=[]; let cur="", inQ=false; for(let i=0;i<line.length;i++){ const c=line[i]; if(inQ){ if(c===String.fromCharCode(34) && line[i+1]===String.fromCharCode(34)){ cur+=String.fromCharCode(34); i++; } else if(c===String.fromCharCode(34)) inQ=false; else cur+=c; } else { if(c===String.fromCharCode(34)) inQ=true; else if(c===","){ out.push(cur); cur=""; } else cur+=c; } } out.push(cur); return out; }',
      c_36: 'function hasOverlappingInterval(intervals: Array<[number,number]>): boolean { for(let i=0;i<intervals.length;i++) for(let j=i+1;j<intervals.length;j++) if(intervals[i][0]<intervals[j][1] && intervals[j][0]<intervals[i][1]) return true; return false; }',
      c_37: 'function evalRPN(tokens: string[]): number { const st:number[]=[]; for(const t of tokens){ if(["+","-","*","/"].includes(t)){ const b=st.pop()!, a=st.pop()!; st.push(t==="+"?a+b:t==="-"?a-b:t==="*"?a*b:Math.trunc(a/b)); } else st.push(Number(t)); } return st[0]; }',
      c_38: 'function computeEMA(values: number[], alpha: number): number[] { const out=[values[0]]; for(let i=1;i<values.length;i++) out.push(alpha*values[i]+(1-alpha)*out[i-1]); return out; }',
      c_39: 'function deepEqual(a: any, b: any): boolean { if(a===b) return true; if(!a || !b || typeof a!=="object" || typeof b!=="object") return false; if(Array.isArray(a)!==Array.isArray(b)) return false; const ka=Object.keys(a), kb=Object.keys(b); if(ka.length!==kb.length) return false; return ka.every(k=>deepEqual(a[k], b[k])); }',
      c_40: 'function createUnionFind(n: number) { const p=Array.from({length:n},(_,i)=>i); const find=(x:number):number=>p[x]===x?x:(p[x]=find(p[x])); return { find, union(a:number,b:number){ const ra=find(a),rb=find(b); if(ra===rb) return false; p[ra]=rb; return true; }, connected(a:number,b:number){ return find(a)===find(b); } }; }',
      c_41: 'function binarySearchBounds(nums: number[], target: number): [number,number] { return [nums.indexOf(target), nums.lastIndexOf(target)]; }',
      c_42: 'function countSubarraysSumK(nums: number[], k: number): number { let c=0; for(let i=0;i<nums.length;i++){ let s=0; for(let j=i;j<nums.length;j++){ s+=nums[j]; if(s===k) c++; } } return c; }',
      c_43: 'function coinChangeMin(coins: number[], amount: number): number { const dp=new Array(amount+1).fill(Infinity); dp[0]=0; for(let a=1;a<=amount;a++) for(const c of coins) if(a>=c) dp[a]=Math.min(dp[a], dp[a-c]+1); return dp[amount]===Infinity?-1:dp[amount]; }',
      c_44: 'function runLengthEncode(s: string): string { if(!s) return ""; let out="", c=1; for(let i=1;i<=s.length;i++){ if(s[i]===s[i-1]) c++; else { out+=s[i-1]+c; c=1; } } return out; }',
      c_45: 'function romanToInt(s: string): number { const m:Record<string,number>={I:1,V:5,X:10,L:50,C:100,D:500,M:1000}; let tot=0; for(let i=0;i<s.length;i++) tot += m[s[i]] < (m[s[i+1]]||0) ? -m[s[i]] : m[s[i]]; return tot; }',
      c_46: 'function longestUniqueSubstring(s: string): number { const m=new Map<string,number>(); let l=0, best=0; for(let r=0;r<s.length;r++){ if(m.has(s[r]) && m.get(s[r])!>=l) l=m.get(s[r])!+1; m.set(s[r],r); best=Math.max(best, r-l+1); } return best; }',
      c_47: 'function wordFrequency(text: string): Record<string,number> { const m:Record<string,number>={}; for(const w of text.toLowerCase().match(/[a-z0-9]+/g)||[]) m[w]=(m[w]||0)+1; return m; }',
      c_48: 'function spiralOrder(matrix: number[][]): number[] { const out:number[]=[]; let t=0,b=matrix.length-1,l=0,r=matrix[0].length-1; while(t<=b && l<=r){ for(let c=l;c<=r;c++) out.push(matrix[t][c]); t++; for(let row=t;row<=b;row++) out.push(matrix[row][r]); r--; if(t<=b){ for(let c=r;c>=l;c--) out.push(matrix[b][c]); b--; } if(l<=r){ for(let row=b;row>=t;row--) out.push(matrix[row][l]); l++; } } return out; }',
      c_49: 'function isAnagram(a: string, b: string): boolean { const norm=(s:string)=>s.toLowerCase().replace(/\\s+/g,"").split("").sort().join(""); return norm(a)===norm(b); }',
      c_50: 'function productExceptSelf(nums: number[]): number[] { const n=nums.length, out=new Array(n).fill(1); let p=1; for(let i=0;i<n;i++){ out[i]=p; p*=nums[i]; } p=1; for(let i=n-1;i>=0;i--){ out[i]*=p; p*=nums[i]; } return out; }',
    };

    for (const q of DISTINCT_BUDGET_QUERIES.code) {
      const impl = referenceImpls[q.id];
      expect(impl, `Missing reference implementation for ${q.id}`).toBeDefined();
      const res = verifyCodeAssertionExecution(impl, q.function_name!, q.assertion_script!);
      expect(res.passed, `${q.id} failed: ${res.detail}`).toBe(true);
    }
  });
});

