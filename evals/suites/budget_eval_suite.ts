/**
 * AEL Thinking Budget Evaluation Suite
 *
 * Expands to 50 held-out queries per category (200 total queries) across:
 * - factual / reasoning lookup (50) — verified via LLM judge verdict
 * - multi-step math/logic (50) — verified via numeric ground-truth match
 * - code synthesis/debugging (50) — verified via esbuild TS compilation + node:vm functional assertion check (NOT a security sandbox)
 * - structured data extraction (50) — verified via JSON parsing + expected field match
 *
 * NOTE ON VALIDATION INTEGRITY:
 * When run without real API keys, this suite operates as a plumbing/smoke test
 * and is explicitly marked as NOT VALIDATED for acceptance criteria.
 * Real model benchmarking requires live API credentials (GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY).
 *
 * @license Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetEngine } from '../../src/engines/budget.js';
import { LLMClient } from '../../src/llm/client.js';
import { DecisionLogStore } from '../../src/db/decision_log.js';
import { CircuitBreakerController } from '../../src/engines/circuit_breaker.js';
import { DEFAULT_PRESETS, ProviderProfile } from '../../src/config/ael_config.js';
import {
  MAX_LIVE_EVAL_COST_USD,
  assertValidGeminiKey,
  assertWithinSpendingGuard,
  estimateProjectedEvalCost,
} from './spending_guard.js';
import {
  VerificationMethod,
  verifyCodeAssertionExecution,
  verifyExtractionJsonFields,
  verifyMathNumericMatch,
  verifyReasoningJudgeVerdict,
} from './budget_verifiers.js';

export interface BudgetEvalOptions {
  live?: boolean;
  maxCostUsd?: number;
}

export interface CategoryMetric {
  category: string;
  verification_method: VerificationMethod;
  total_samples: number;
  baseline_tokens: number;
  actual_tokens: number;
  token_reduction_ratio: string;
  token_reduction_pct: number;
  baseline_cost_usd: number;
  actual_cost_usd: number;
  net_cost_saved_usd: number;
  baseline_correct: number;
  baseline_accuracy_ratio: string;
  baseline_accuracy: number;
  actual_correct: number;
  accuracy_ratio: string;
  accuracy: number;
  accuracy_delta_pp: number;
  p95_overhead_ms: number;
}

export interface BudgetEvalResult {
  suite_name: string;
  benchmark_type: 'comparative_benchmark_identical_samples';
  benchmark_methodology: string;
  split: 'held_out' | 'tuning';
  timestamp: string;
  execution_date: string;
  run_command: string;
  live_api_credentials_present: boolean;
  provider_source: string;
  acceptance_status:
    | 'PASS'
    | 'NOT VALIDATED (No live upstream API credentials configured)'
    | 'NOT VALIDATED (Thresholds not reached)';
  total_queries: number;
  overall_baseline_tokens: number;
  overall_actual_tokens: number;
  overall_token_reduction_ratio: string;
  overall_token_reduction_pct: number;
  overall_net_savings_usd: number;
  usd_per_task_baseline: number;
  usd_per_task_ael: number;
  overall_baseline_correct: number;
  overall_baseline_accuracy_ratio: string;
  baseline_accuracy: number;
  overall_actual_correct: number;
  overall_accuracy_ratio: string;
  overall_accuracy: number;
  accuracy_drop_pp: number;
  overall_p95_overhead_ms: number;
  categories: Record<string, CategoryMetric>;
}

export interface EvalQueryCase {
  id: string;
  category: 'factual' | 'math' | 'code' | 'extraction';
  query: string;
  difficulty: 'simple' | 'medium' | 'hard';
  expected_sub?: string;
  expected_number?: number;
  tolerance?: number;
  function_name?: string;
  assertion_script?: string;
  expected_json?: Record<string, string | number | boolean>;
}

// 200 genuinely unique, self-contained queries (50 per category) with real ground-truth verifiers
export const DISTINCT_BUDGET_QUERIES: Record<'factual' | 'math' | 'code' | 'extraction', EvalQueryCase[]> = {
  factual: [
    { id: 'f_1', category: 'factual', query: 'What year did the Apollo 11 mission successfully land on the Moon?', expected_sub: '1969', difficulty: 'simple' },
    { id: 'f_2', category: 'factual', query: 'Identify the capital of Kazakhstan and its previous name used between 2019 and 2022.', expected_sub: 'Astana (formerly Nur-Sultan)', difficulty: 'simple' },
    { id: 'f_3', category: 'factual', query: 'What is the primary organic compound that causes the characteristic smell of rain on dry earth?', expected_sub: 'Geosmin', difficulty: 'medium' },
    { id: 'f_4', category: 'factual', query: 'Which 1713 treaty concluded the War of the Spanish Succession?', expected_sub: 'Treaty of Utrecht', difficulty: 'medium' },
    { id: 'f_5', category: 'factual', query: 'Explain the primary difference between NHEJ and HDR in CRISPR-Cas9 double-strand DNA break repair.', expected_sub: 'NHEJ ligates ends directly (error-prone); HDR uses a homologous template', difficulty: 'hard' },
    { id: 'f_6', category: 'factual', query: 'Which Portuguese navigator rounded the Cape of Good Hope in 1488?', expected_sub: 'Bartolomeu Dias', difficulty: 'hard' },
    { id: 'f_7', category: 'factual', query: 'Which fissile isotope of Uranium is primarily used in commercial pressurized water reactors?', expected_sub: 'Uranium-235', difficulty: 'simple' },
    { id: 'f_8', category: 'factual', query: 'In what year did the First Council of Nicaea convene?', expected_sub: '325 AD', difficulty: 'simple' },
    { id: 'f_9', category: 'factual', query: 'Name the deepest known oceanic trench on Earth and its deepest surveyed point.', expected_sub: 'Mariana Trench / Challenger Deep', difficulty: 'medium' },
    { id: 'f_10', category: 'factual', query: 'Identify the Austrian physicist who formulated the non-relativistic quantum wave equation in 1926.', expected_sub: 'Erwin Schrodinger', difficulty: 'medium' },
    { id: 'f_11', category: 'factual', query: 'What is the biological term for the programmed lysosome-mediated degradation of cellular organelles within autophagosomes?', expected_sub: 'Autophagy', difficulty: 'hard' },
    { id: 'f_12', category: 'factual', query: 'Which 1648 peace treaties established the principle of state sovereignty in Western Europe?', expected_sub: 'Peace of Westphalia', difficulty: 'hard' },
    { id: 'f_13', category: 'factual', query: 'What is the astronomical term for the boundary around a black hole beyond which light cannot escape?', expected_sub: 'Event horizon', difficulty: 'simple' },
    { id: 'f_14', category: 'factual', query: 'Identify the primary alkaloid in Atropa belladonna that acts as a competitive muscarinic antagonist.', expected_sub: 'Atropine', difficulty: 'medium' },
    { id: 'f_15', category: 'factual', query: 'Who was the 13th-century Venetian traveler whose accounts introduced Kublai Khan and the Yuan dynasty to Europe?', expected_sub: 'Marco Polo', difficulty: 'simple' },
    { id: 'f_16', category: 'factual', query: 'Which German rotor cipher machine was broken by Marian Rejewski and Alan Turing at Bletchley Park?', expected_sub: 'Enigma machine', difficulty: 'medium' },
    { id: 'f_17', category: 'factual', query: 'What mineral has the highest rating of 10 on the Mohs scale of hardness?', expected_sub: 'Diamond', difficulty: 'simple' },
    { id: 'f_18', category: 'factual', query: 'Which Neo-Assyrian king established the famous royal clay-tablet library at Nineveh?', expected_sub: 'Ashurbanipal', difficulty: 'hard' },
    { id: 'f_19', category: 'factual', query: 'In molecular biology, which ribonucleoprotein enzyme elongates telomeric DNA repeats at chromosome ends?', expected_sub: 'Telomerase', difficulty: 'hard' },
    { id: 'f_20', category: 'factual', query: 'Which 1992 treaty created the European Union and laid the groundwork for the euro?', expected_sub: 'Maastricht Treaty', difficulty: 'medium' },
    { id: 'f_21', category: 'factual', query: 'Name the celestial body discovered by Clyde Tombaugh in 1930 and reclassified as a dwarf planet in 2006.', expected_sub: 'Pluto', difficulty: 'simple' },
    { id: 'f_22', category: 'factual', query: 'What is the SI derived unit of electrical capacitance?', expected_sub: 'Farad', difficulty: 'simple' },
    { id: 'f_23', category: 'factual', query: 'Which surface glycoprotein receptor characterizes cytotoxic T lymphocytes as distinct from CD4+ helper T cells?', expected_sub: 'CD8', difficulty: 'hard' },
    { id: 'f_24', category: 'factual', query: 'Name the decisive 31 BC naval battle where Octavian defeated Mark Antony and Cleopatra.', expected_sub: 'Battle of Actium', difficulty: 'medium' },
    { id: 'f_25', category: 'factual', query: 'What thermodynamic state exists when temperature, pressure, and chemical potential are uniform throughout a system?', expected_sub: 'Thermodynamic equilibrium', difficulty: 'medium' },
    { id: 'f_26', category: 'factual', query: 'Identify the German chemist who synthesized urea from ammonium cyanate in 1828.', expected_sub: 'Friedrich Wohler', difficulty: 'hard' },
    { id: 'f_27', category: 'factual', query: 'Which transform fault in California separates the Pacific Plate from the North American Plate?', expected_sub: 'San Andreas Fault', difficulty: 'simple' },
    { id: 'f_28', category: 'factual', query: 'Who authored the 1687 treatise Philosophiae Naturalis Principia Mathematica?', expected_sub: 'Isaac Newton', difficulty: 'simple' },
    { id: 'f_29', category: 'factual', query: 'Which language family includes Finnish, Estonian, and Hungarian?', expected_sub: 'Uralic', difficulty: 'hard' },
    { id: 'f_30', category: 'factual', query: 'Which enzyme synthesizes complementary DNA (cDNA) from an RNA template in retroviruses?', expected_sub: 'Reverse transcriptase', difficulty: 'hard' },
    { id: 'f_31', category: 'factual', query: 'Which Byzantine emperor codified Roman law into the Corpus Juris Civilis in the 6th century?', expected_sub: 'Justinian I', difficulty: 'medium' },
    { id: 'f_32', category: 'factual', query: 'Which Greek letter denotes Einstein’s cosmological constant in general relativity?', expected_sub: 'Lambda', difficulty: 'medium' },
    { id: 'f_33', category: 'factual', query: 'Which endocrine gland in the brain secretes melatonin to regulate circadian rhythms?', expected_sub: 'Pineal gland', difficulty: 'simple' },
    { id: 'f_34', category: 'factual', query: 'Who invented dynamite and established the Nobel Prizes in his 1895 will?', expected_sub: 'Alfred Nobel', difficulty: 'simple' },
    { id: 'f_35', category: 'factual', query: 'Name the beta-(1,4)-linked D-glucose structural polysaccharide forming plant cell walls.', expected_sub: 'Cellulose', difficulty: 'medium' },
    { id: 'f_36', category: 'factual', query: 'Which 1814-1815 international congress redrew European borders after Napoleon’s defeat?', expected_sub: 'Congress of Vienna', difficulty: 'medium' },
    { id: 'f_37', category: 'factual', query: 'What is the approximate radioactive half-life of Carbon-14 in years?', expected_sub: '5730 years', difficulty: 'hard' },
    { id: 'f_38', category: 'factual', query: 'Which mathematician completed the proof of Fermat’s Last Theorem in 1994?', expected_sub: 'Andrew Wiles', difficulty: 'hard' },
    { id: 'f_39', category: 'factual', query: 'Which optical phenomenon separates white light into its constituent wavelengths inside a prism?', expected_sub: 'Dispersion', difficulty: 'simple' },
    { id: 'f_40', category: 'factual', query: 'Which 1944 conference established the IMF and the World Bank?', expected_sub: 'Bretton Woods Conference', difficulty: 'medium' },
    { id: 'f_41', category: 'factual', query: 'What iron-containing protein in red blood cells transports oxygen in mammals?', expected_sub: 'Hemoglobin', difficulty: 'simple' },
    { id: 'f_42', category: 'factual', query: 'What type of tectonic plate boundary occurs along the Mid-Atlantic Ridge?', expected_sub: 'Divergent boundary', difficulty: 'medium' },
    { id: 'f_43', category: 'factual', query: 'Who proved the incompleteness theorems for formal axiomatic arithmetic systems in 1931?', expected_sub: 'Kurt Godel', difficulty: 'hard' },
    { id: 'f_44', category: 'factual', query: 'Which Indonesian volcano erupted cataclysmically in August 1883 in the Sunda Strait?', expected_sub: 'Krakatoa', difficulty: 'medium' },
    { id: 'f_45', category: 'factual', query: 'What is the primary fast excitatory neurotransmitter in the mammalian central nervous system?', expected_sub: 'Glutamate', difficulty: 'hard' },
    { id: 'f_46', category: 'factual', query: 'Which Roman emperor issued the Edict of Thessalonica in 380 AD making Nicene Christianity the state church?', expected_sub: 'Theodosius I', difficulty: 'hard' },
    { id: 'f_47', category: 'factual', query: 'What is the approximate speed of sound in dry air at 20 degrees Celsius in meters per second?', expected_sub: '343 m/s', difficulty: 'simple' },
    { id: 'f_48', category: 'factual', query: 'Which 19th-century Scottish physicist unified electricity, magnetism, and light into four field equations?', expected_sub: 'James Clerk Maxwell', difficulty: 'simple' },
    { id: 'f_49', category: 'factual', query: 'Which double-membraned eukaryotic organelle produces most cellular ATP via oxidative phosphorylation?', expected_sub: 'Mitochondria', difficulty: 'simple' },
    { id: 'f_50', category: 'factual', query: 'Which British Prime Minister delivered the "Blood, Toil, Tears and Sweat" speech in May 1940?', expected_sub: 'Winston Churchill', difficulty: 'simple' },
  ],
  math: [
    { id: 'm_1', category: 'math', query: 'Compute the sum of the distinct prime factors of 360. Give the exact integer answer.', expected_number: 10, difficulty: 'simple' },
    { id: 'm_2', category: 'math', query: 'Calculate a 15% tip on a restaurant bill of $84.60. Give the exact dollar amount.', expected_number: 12.69, tolerance: 0.01, difficulty: 'simple' },
    { id: 'm_3', category: 'math', query: 'A 10-meter ladder leans against a vertical wall at a 60-degree angle to the ground. How high up the wall in meters does it reach (2 decimals)?', expected_number: 8.66, tolerance: 0.02, difficulty: 'medium' },
    { id: 'm_4', category: 'math', query: 'Find the remainder when 3^100 is divided by 7.', expected_number: 4, difficulty: 'medium' },
    { id: 'm_5', category: 'math', query: 'For y\'\' - 4y\' + 13y = 0 with y(0) = 2 and y\'(0) = 4, compute y(pi/6) rounded to 2 decimal places.', expected_number: 0, tolerance: 0.02, difficulty: 'hard' },
    { id: 'm_6', category: 'math', query: 'A 2-state Markov chain has transition matrix P = [[0.7, 0.3], [0.4, 0.6]]. What is the stationary probability pi_1 of state 1 (2 decimals)?', expected_number: 0.57, tolerance: 0.01, difficulty: 'hard' },
    { id: 'm_7', category: 'math', query: 'Compute the determinant of the 3x3 matrix [[3, 2, -1], [0, 4, 5], [-2, 1, 3]].', expected_number: -7, difficulty: 'medium' },
    { id: 'm_8', category: 'math', query: 'A fair 6-sided die is rolled 3 times. What is the probability of getting at least two sixes? Give a decimal rounded to 4 decimal places.', expected_number: 0.0741, tolerance: 0.001, difficulty: 'hard' },
    { id: 'm_9', category: 'math', query: 'Evaluate the definite integral of x * exp(-x^2) dx from x = 0 to x = infinity.', expected_number: 0.5, tolerance: 0.001, difficulty: 'medium' },
    { id: 'm_10', category: 'math', query: 'What is the trace of the 2x2 matrix [[7, -3], [4, 5]]?', expected_number: 12, difficulty: 'medium' },
    { id: 'm_11', category: 'math', query: 'Compute the simple annual interest earned on $4,000 at 6.5% over 3 years.', expected_number: 780, difficulty: 'medium' },
    { id: 'm_12', category: 'math', query: 'Find the greatest common divisor (GCD) of 14,328 and 4,116.', expected_number: 12, difficulty: 'simple' },
    { id: 'm_13', category: 'math', query: 'Find the smallest positive integer x satisfying x ≡ 2 (mod 3), x ≡ 3 (mod 5), and x ≡ 2 (mod 7).', expected_number: 23, difficulty: 'hard' },
    { id: 'm_14', category: 'math', query: 'What is the sum of the infinite geometric series 12 + 4 + 4/3 + 4/9 + ...?', expected_number: 18, difficulty: 'simple' },
    { id: 'm_15', category: 'math', query: 'What is the radius of convergence R of the power series sum_{n=1}^{inf} (2^n * x^n) / n?', expected_number: 0.5, tolerance: 0.001, difficulty: 'hard' },
    { id: 'm_16', category: 'math', query: 'Compute the volume of a sphere of radius 3 cm rounded to 2 decimal places.', expected_number: 113.1, tolerance: 0.05, difficulty: 'simple' },
    { id: 'm_17', category: 'math', query: 'How many distinct permutations can be formed from the letters of the word MISSISSIPPI?', expected_number: 34650, difficulty: 'medium' },
    { id: 'm_18', category: 'math', query: 'What is the divergence of vector field F(x, y, z) = (3x^2, 2y, -z) at point (1, 2, 3)?', expected_number: 7, difficulty: 'hard' },
    { id: 'm_19', category: 'math', query: 'Given the recurrence a_n = 5*a_{n-1} - 6*a_{n-2} with a_0 = 1 and a_1 = 4, compute a_4.', expected_number: 146, difficulty: 'hard' },
    { id: 'm_20', category: 'math', query: 'Find the minimum value of f(x, y) = (x - 3)^2 + (y + 2)^2 + 11.', expected_number: 11, difficulty: 'hard' },
    { id: 'm_21', category: 'math', query: 'Evaluate the line integral of conservative field F(x, y) = (2xy, x^2) from (0,0) to (2,4) (potential phi = x^2 y).', expected_number: 16, difficulty: 'hard' },
    { id: 'm_22', category: 'math', query: 'If X ~ Poisson(lambda = 4), compute P(X = 2) = (4^2 * e^-4) / 2! rounded to 4 decimal places.', expected_number: 0.1465, tolerance: 0.001, difficulty: 'medium' },
    { id: 'm_23', category: 'math', query: 'Compute the squared Frobenius norm ||A||_F^2 of matrix [[4, -2], [3, 1]].', expected_number: 30, difficulty: 'simple' },
    { id: 'm_24', category: 'math', query: 'What is the area of a triangle with vertices at (1, 2), (4, 6), and (7, 1)?', expected_number: 13.5, tolerance: 0.01, difficulty: 'simple' },
    { id: 'm_25', category: 'math', query: 'What is the coefficient of x^3 in the Maclaurin series of ln(1 + x)? Express as a decimal rounded to 4 decimal places.', expected_number: 0.3333, tolerance: 0.001, difficulty: 'medium' },
    { id: 'm_26', category: 'math', query: 'Calculate the total surface area of a right cone with radius 5 cm and slant height 13 cm (rounded to 2 decimals).', expected_number: 282.74, tolerance: 0.05, difficulty: 'simple' },
    { id: 'm_27', category: 'math', query: 'Evaluate sum_{k=1}^{10} k^2.', expected_number: 385, difficulty: 'medium' },
    { id: 'm_28', category: 'math', query: 'Compute the DC component X[0] of the 4-point DFT of sequence [1, 0, 2, 0].', expected_number: 3, difficulty: 'hard' },
    { id: 'm_29', category: 'math', query: 'Find the smallest positive solution x to x^2 ≡ 5 (mod 11).', expected_number: 4, difficulty: 'hard' },
    { id: 'm_30', category: 'math', query: 'Find the distance between the parallel planes 2x - y + 2z = 4 and 2x - y + 2z = -5.', expected_number: 3, difficulty: 'medium' },
    { id: 'm_31', category: 'math', query: 'Evaluate the limit as x -> 0 of (sin(3x) - 3x) / x^3.', expected_number: -4.5, tolerance: 0.01, difficulty: 'medium' },
    { id: 'm_32', category: 'math', query: 'If u = (1, 2, 3) and v = (4, -1, 2), calculate the dot product u . v.', expected_number: 8, difficulty: 'simple' },
    { id: 'm_33', category: 'math', query: 'Given P(A) = 0.3, P(B) = 0.5, and P(B|A) = 0.8, calculate P(A|B) using Bayes theorem.', expected_number: 0.48, tolerance: 0.005, difficulty: 'medium' },
    { id: 'm_34', category: 'math', query: 'What is the chromatic number of the complete bipartite graph K_{3, 5}?', expected_number: 2, difficulty: 'simple' },
    { id: 'm_35', category: 'math', query: 'If x^2 + xy + y^2 = 7 and x = 1, y = 2 initially, what is C = x^2 + xy + y^2 at (2, 1)?', expected_number: 7, difficulty: 'hard' },
    { id: 'm_36', category: 'math', query: 'Compute the arc length of the helix x = cos(t), y = sin(t), z = t for t from 0 to 2*pi (2 decimals).', expected_number: 8.89, tolerance: 0.02, difficulty: 'medium' },
    { id: 'm_37', category: 'math', query: 'Determine the number of positive divisors of the integer 720.', expected_number: 30, difficulty: 'simple' },
    { id: 'm_38', category: 'math', query: 'Evaluate the double integral of (x^2 + y^2) over the unit disk x^2 + y^2 <= 1 (2 decimals, pi/2).', expected_number: 1.57, tolerance: 0.01, difficulty: 'medium' },
    { id: 'm_39', category: 'math', query: 'What is the expected value of the maximum of two independent Uniform(0, 1) random variables (rounded to 4 decimals)?', expected_number: 0.6667, tolerance: 0.001, difficulty: 'medium' },
    { id: 'm_40', category: 'math', query: 'Compute the determinant of [[2, 5], [1, 4]].', expected_number: 3, difficulty: 'simple' },
    { id: 'm_41', category: 'math', query: 'How many real critical points does V(x) = x^4 - 2x^2 + 1 have?', expected_number: 3, difficulty: 'medium' },
    { id: 'm_42', category: 'math', query: 'Compute the 95% z-interval margin of error (z = 1.96) for a normal sample with n = 100 and s = 15.', expected_number: 2.94, tolerance: 0.01, difficulty: 'simple' },
    { id: 'm_43', category: 'math', query: 'What is the 10th Fibonacci number F_10 where F_0 = 0, F_1 = 1?', expected_number: 55, difficulty: 'hard' },
    { id: 'm_44', category: 'math', query: 'Find the angle in degrees between vectors (1, 1, 0) and (0, 1, 1).', expected_number: 60, difficulty: 'simple' },
    { id: 'm_45', category: 'math', query: 'Calculate the Euler totient function phi(360).', expected_number: 96, difficulty: 'simple' },
    { id: 'm_46', category: 'math', query: 'Solve 3x + 2y = 12 and 5x - 4y = 9 and compute x + y (exact decimal: x=3, y=1.5).', expected_number: 4.5, tolerance: 0.01, difficulty: 'medium' },
    { id: 'm_47', category: 'math', query: 'Evaluate the imaginary coefficient (result / i) of the contour integral of 1/(z - 2) counterclockwise around |z| = 3 (2 decimals: 2*pi).', expected_number: 6.28, tolerance: 0.02, difficulty: 'hard' },
    { id: 'm_48', category: 'math', query: 'What is the variance of a Binomial(n = 50, p = 0.4) random variable?', expected_number: 12, difficulty: 'simple' },
    { id: 'm_49', category: 'math', query: 'Determine the largest singular value of the diagonal matrix [[6, 0], [0, -8]].', expected_number: 8, difficulty: 'simple' },
    { id: 'm_50', category: 'math', query: 'A directed graph has edges A->B (weight 2), B->C (weight 3), A->C (weight 7), C->E (weight 4). What is the shortest path distance from A to E?', expected_number: 9, difficulty: 'hard' },
  ],
  code: [
    {
      id: 'c_1', category: 'code', difficulty: 'simple',
      query: 'Write a TypeScript function `reverseInPlace<T>(arr: T[]): T[]` that reverses an array in-place without calling Array.prototype.reverse and returns it.',
      function_name: 'reverseInPlace',
      assertion_script: 'const a=[1,2,3,4]; assert.strictEqual(reverseInPlace(a), a); assert.deepStrictEqual(a, [4,3,2,1]); assert.deepStrictEqual(reverseInPlace([]), []);',
    },
    {
      id: 'c_2', category: 'code', difficulty: 'simple',
      query: 'Write a TypeScript function `truncateText(text: string, maxLen: number): string` that returns text unchanged if text.length <= maxLen, otherwise truncates to maxLen chars total ending with "..." (or slice if maxLen <= 3).',
      function_name: 'truncateText',
      assertion_script: 'assert.strictEqual(truncateText("hello", 5), "hello"); assert.strictEqual(truncateText("hello world", 8), "hello...");',
    },
    {
      id: 'c_3', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `clamp(value: number, min: number, max: number): number` that clamps value within [min, max].',
      function_name: 'clamp',
      assertion_script: 'assert.strictEqual(clamp(5, 0, 10), 5); assert.strictEqual(clamp(-3, 0, 10), 0); assert.strictEqual(clamp(42, 0, 10), 10);',
    },
    {
      id: 'c_4', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `chunkArray<T>(arr: T[], size: number): T[][]` that splits arr into chunks of length size.',
      function_name: 'chunkArray',
      assertion_script: 'assert.deepStrictEqual(chunkArray([1,2,3,4,5], 2), [[1,2],[3,4],[5]]); assert.deepStrictEqual(chunkArray([], 3), []);',
    },
    {
      id: 'c_5', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `createRingBuffer(capacity: number)` returning an object with `push(v: number): boolean` and `pop(): number | undefined` implementing a FIFO circular buffer (returns false on push if full).',
      function_name: 'createRingBuffer',
      assertion_script: 'const rb=createRingBuffer(2); assert.strictEqual(rb.push(10), true); assert.strictEqual(rb.push(20), true); assert.strictEqual(rb.push(30), false); assert.strictEqual(rb.pop(), 10); assert.strictEqual(rb.push(30), true); assert.strictEqual(rb.pop(), 20); assert.strictEqual(rb.pop(), 30); assert.strictEqual(rb.pop(), undefined);',
    },
    {
      id: 'c_6', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `topoSort(nodes: string[], edges: Array<[string, string]>): string[] | null` returning a topological ordering or null if a cycle exists.',
      function_name: 'topoSort',
      assertion_script: 'const order=topoSort(["a","b","c"], [["a","b"],["b","c"]]); assert.deepStrictEqual(order, ["a","b","c"]); assert.strictEqual(topoSort(["a","b"], [["a","b"],["b","a"]]), null);',
    },
    {
      id: 'c_7', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `createLRUCache<K, V>(capacity: number)` returning `{ get(k: K): V | undefined; put(k: K, v: V): void }` with O(1) Map eviction.',
      function_name: 'createLRUCache',
      assertion_script: 'const c=createLRUCache(2); c.put("a",1); c.put("b",2); assert.strictEqual(c.get("a"), 1); c.put("c",3); assert.strictEqual(c.get("b"), undefined); assert.strictEqual(c.get("c"), 3);',
    },
    {
      id: 'c_8', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createMinHeap()` returning `{ push(n: number): void; pop(): number | undefined; peek(): number | undefined; size(): number }`.',
      function_name: 'createMinHeap',
      assertion_script: 'const h=createMinHeap(); h.push(5); h.push(1); h.push(3); assert.strictEqual(h.peek(), 1); assert.strictEqual(h.pop(), 1); assert.strictEqual(h.pop(), 3); assert.strictEqual(h.pop(), 5);',
    },
    {
      id: 'c_9', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]>` grouping items by key.',
      function_name: 'groupBy',
      assertion_script: 'assert.deepStrictEqual(groupBy(["ant","bear","ape"], s => s[0]), { a: ["ant","ape"], b: ["bear"] });',
    },
    {
      id: 'c_10', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `deepClone<T>(val: T, seen = new WeakMap()): T` supporting primitives, plain objects, arrays, Dates, and cyclic references.',
      function_name: 'deepClone',
      assertion_script: 'const obj={a:1, b:[2,3]}; obj.self=obj; const cloned=deepClone(obj); assert.notStrictEqual(cloned, obj); assert.strictEqual(cloned.self, cloned); assert.deepStrictEqual(cloned.b, [2,3]);',
    },
    {
      id: 'c_11', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createTrie()` returning `{ insert(w: string): void; search(w: string): boolean; startsWith(p: string): boolean }`.',
      function_name: 'createTrie',
      assertion_script: 'const t=createTrie(); t.insert("apple"); assert.strictEqual(t.search("apple"), true); assert.strictEqual(t.search("app"), false); assert.strictEqual(t.startsWith("app"), true);',
    },
    {
      id: 'c_12', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createEmitter()` returning `{ on(ev: string, fn: Function): void; off(ev: string, fn: Function): void; emit(ev: string, ...args: any[]): void }`.',
      function_name: 'createEmitter',
      assertion_script: 'const e=createEmitter(); let n=0; const fn=(x)=>{n+=x}; e.on("inc", fn); e.emit("inc", 3); e.off("inc", fn); e.emit("inc", 5); assert.strictEqual(n, 3);',
    },
    {
      id: 'c_13', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]>` merging overlapping intervals and sorting ascending.',
      function_name: 'mergeIntervals',
      assertion_script: 'assert.deepStrictEqual(mergeIntervals([[1,3],[2,6],[8,10],[15,18]]), [[1,6],[8,10],[15,18]]); assert.deepStrictEqual(mergeIntervals([[1,4],[4,5]]), [[1,5]]);',
    },
    {
      id: 'c_14', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createTokenBucket(capacity: number, refillPerSec: number)` with `consume(tokens: number, nowSec: number): boolean` refilling proportionally to elapsed time.',
      function_name: 'createTokenBucket',
      assertion_script: 'const b=createTokenBucket(5, 1); assert.strictEqual(b.consume(5, 0), true); assert.strictEqual(b.consume(1, 0.5), false); assert.strictEqual(b.consume(2, 2.5), true);',
    },
    {
      id: 'c_15', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `flattenObject(obj: Record<string, any>, prefix = ""): Record<string, any>` flattening nested objects using dot-separated keys.',
      function_name: 'flattenObject',
      assertion_script: 'assert.deepStrictEqual(flattenObject({a:{b:1, c:{d:2}}, e:3}), {"a.b":1, "a.c.d":2, "e":3});',
    },
    {
      id: 'c_16', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `searchRotated(nums: number[], target: number): number` finding target index in O(log n) in a rotated sorted array or returning -1.',
      function_name: 'searchRotated',
      assertion_script: 'assert.strictEqual(searchRotated([4,5,6,7,0,1,2], 0), 4); assert.strictEqual(searchRotated([4,5,6,7,0,1,2], 3), -1);',
    },
    {
      id: 'c_17', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `isValidBrackets(s: string): boolean` checking balanced (), [], and {} brackets.',
      function_name: 'isValidBrackets',
      assertion_script: 'assert.strictEqual(isValidBrackets("({[]})"), true); assert.strictEqual(isValidBrackets("([)]"), false); assert.strictEqual(isValidBrackets(""), true);',
    },
    {
      id: 'c_18', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createFSM(initial: string, transitions: Record<string, Record<string, string>>)` returning `{ state(): string; send(event: string): string }`.',
      function_name: 'createFSM',
      assertion_script: 'const m=createFSM("idle", {idle:{START:"running"}, running:{STOP:"idle"}}); assert.strictEqual(m.send("START"), "running"); assert.strictEqual(m.send("NOOP"), "running"); assert.strictEqual(m.send("STOP"), "idle");',
    },
    {
      id: 'c_19', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `memoize<A extends any[], R>(fn: (...args: A) => R): (...args: A) => R` caching results by JSON.stringify(args).',
      function_name: 'memoize',
      assertion_script: 'let calls=0; const f=memoize((a,b)=>{calls++; return a+b;}); assert.strictEqual(f(1,2), 3); assert.strictEqual(f(1,2), 3); assert.strictEqual(calls, 1); assert.strictEqual(f(2,3), 5); assert.strictEqual(calls, 2);',
    },
    {
      id: 'c_20', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `quickselect(nums: number[], k: number): number` returning the k-th smallest element (0-indexed).',
      function_name: 'quickselect',
      assertion_script: 'assert.strictEqual(quickselect([7,10,4,3,20,15], 2), 7); assert.strictEqual(quickselect([3,2,1], 0), 1);',
    },
    {
      id: 'c_21', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createCounterBreaker(threshold: number)` returning `{ recordFailure(): void; recordSuccess(): void; state(): "CLOSED" | "OPEN" }` opening when consecutive failures >= threshold and closing on success.',
      function_name: 'createCounterBreaker',
      assertion_script: 'const cb=createCounterBreaker(2); assert.strictEqual(cb.state(), "CLOSED"); cb.recordFailure(); assert.strictEqual(cb.state(), "CLOSED"); cb.recordFailure(); assert.strictEqual(cb.state(), "OPEN"); cb.recordSuccess(); assert.strictEqual(cb.state(), "CLOSED");',
    },
    {
      id: 'c_22', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `topKFrequent(nums: number[], k: number): number[]` returning the k most frequent numbers sorted by frequency descending.',
      function_name: 'topKFrequent',
      assertion_script: 'assert.deepStrictEqual(topKFrequent([1,1,1,2,2,3], 2), [1,2]);',
    },
    {
      id: 'c_23', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `lcsLength(a: string, b: string): number` returning the Longest Common Subsequence length of two strings.',
      function_name: 'lcsLength',
      assertion_script: 'assert.strictEqual(lcsLength("abcde", "ace"), 3); assert.strictEqual(lcsLength("abc", "def"), 0);',
    },
    {
      id: 'c_24', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `levenshtein(a: string, b: string): number` computing edit distance between strings a and b.',
      function_name: 'levenshtein',
      assertion_script: 'assert.strictEqual(levenshtein("kitten", "sitting"), 3); assert.strictEqual(levenshtein("", "abc"), 3);',
    },
    {
      id: 'c_25', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `encodeVarint(n: number): number[]` encoding a non-negative integer as LEB128 7-bit varint bytes.',
      function_name: 'encodeVarint',
      assertion_script: 'assert.deepStrictEqual(encodeVarint(0), [0]); assert.deepStrictEqual(encodeVarint(300), [172, 2]);',
    },
    {
      id: 'c_26', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `shortestGridPath(grid: number[][]): number` using BFS on a 0/1 matrix (0=open, 1=blocked) returning min steps from (0,0) to (rows-1, cols-1) or -1.',
      function_name: 'shortestGridPath',
      assertion_script: 'assert.strictEqual(shortestGridPath([[0,0,0],[1,1,0],[0,0,0]]), 4); assert.strictEqual(shortestGridPath([[0,1],[1,0]]), -1);',
    },
    {
      id: 'c_27', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `serializeLevelOrder(root: { val: number; left?: any; right?: any } | null): (number | null)[]` trimming trailing nulls.',
      function_name: 'serializeLevelOrder',
      assertion_script: 'assert.deepStrictEqual(serializeLevelOrder({val:1, left:{val:2}, right:{val:3, right:{val:4}}}), [1,2,3,null,null,null,4]); assert.deepStrictEqual(serializeLevelOrder(null), []);',
    },
    {
      id: 'c_28', category: 'code', difficulty: 'simple',
      query: 'Write a TypeScript function `pipe<T>(...fns: Array<(x: T) => T>): (x: T) => T` composing functions left-to-right.',
      function_name: 'pipe',
      assertion_script: 'const f=pipe((x)=>x+1, (x)=>x*3); assert.strictEqual(f(2), 9);',
    },
    {
      id: 'c_29', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `camelToSnake(s: string): string` converting camelCase or PascalCase to lowercase snake_case.',
      function_name: 'camelToSnake',
      assertion_script: 'assert.strictEqual(camelToSnake("helloWorldFoo"), "hello_world_foo"); assert.strictEqual(camelToSnake("MyTest"), "my_test");',
    },
    {
      id: 'c_30', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `mergeSortedLists(a: number[], b: number[]): number[]` merging two sorted arrays into one sorted array in O(n+m).',
      function_name: 'mergeSortedLists',
      assertion_script: 'assert.deepStrictEqual(mergeSortedLists([1,3,5], [2,4,6]), [1,2,3,4,5,6]); assert.deepStrictEqual(mergeSortedLists([], [1,2]), [1,2]);',
    },
    {
      id: 'c_31', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `arrayDiff(a: number[], b: number[]): { added: number[]; removed: number[] }` returning unique items added in b vs a and removed from a.',
      function_name: 'arrayDiff',
      assertion_script: 'assert.deepStrictEqual(arrayDiff([1,2,3], [2,3,4]), { added: [4], removed: [1] });',
    },
    {
      id: 'c_32', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `fnv1aHash(str: string): number` computing unsigned 32-bit FNV-1a hash (offset 2166136261, prime 16777619).',
      function_name: 'fnv1aHash',
      assertion_script: 'assert.strictEqual(fnv1aHash("hello"), 1335831723); assert.strictEqual(fnv1aHash(""), 2166136261);',
    },
    {
      id: 'c_33', category: 'code', difficulty: 'simple',
      query: 'Write a TypeScript function `uniqueValues<T>(arr: T[]): T[]` preserving first-seen insertion order.',
      function_name: 'uniqueValues',
      assertion_script: 'assert.deepStrictEqual(uniqueValues([3,1,2,1,3,4]), [3,1,2,4]);',
    },
    {
      id: 'c_34', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `maxSlidingWindow(nums: number[], k: number): number[]` computing maximum of every window of size k.',
      function_name: 'maxSlidingWindow',
      assertion_script: 'assert.deepStrictEqual(maxSlidingWindow([1,3,-1,-3,5,3,6,7], 3), [3,3,5,5,6,7]);',
    },
    {
      id: 'c_35', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `parseCsvLine(line: string): string[]` supporting quoted fields containing commas and escaped double-quotes ("").',
      function_name: 'parseCsvLine',
      assertion_script: 'assert.deepStrictEqual(parseCsvLine(\'a,"b,c","d""e",f\'), ["a","b,c",\'d"e\',"f"]);',
    },
    {
      id: 'c_36', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `hasOverlappingInterval(intervals: Array<[number, number]>): boolean` returning true if any two intervals overlap strictly (start1 < end2 && start2 < end1).',
      function_name: 'hasOverlappingInterval',
      assertion_script: 'assert.strictEqual(hasOverlappingInterval([[1,3],[3,5]]), false); assert.strictEqual(hasOverlappingInterval([[1,4],[2,5]]), true);',
    },
    {
      id: 'c_37', category: 'code', difficulty: 'simple',
      query: 'Write a TypeScript function `evalRPN(tokens: string[]): number` evaluating Reverse Polish Notation with +, -, *, / (truncating division toward zero).',
      function_name: 'evalRPN',
      assertion_script: 'assert.strictEqual(evalRPN(["2","1","+","3","*"]), 9); assert.strictEqual(evalRPN(["4","13","5","/","+"]), 6);',
    },
    {
      id: 'c_38', category: 'code', difficulty: 'simple',
      query: 'Write a TypeScript function `computeEMA(values: number[], alpha: number): number[]` where ema[0]=values[0] and ema[i]=alpha*values[i]+(1-alpha)*ema[i-1].',
      function_name: 'computeEMA',
      assertion_script: 'const r=computeEMA([10, 20, 30], 0.5); assert.deepStrictEqual(r, [10, 15, 22.5]);',
    },
    {
      id: 'c_39', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `deepEqual(a: any, b: any): boolean` comparing primitives, arrays, and plain objects recursively.',
      function_name: 'deepEqual',
      assertion_script: 'assert.strictEqual(deepEqual({a:[1,{b:2}]}, {a:[1,{b:2}]}), true); assert.strictEqual(deepEqual({a:1}, {a:2}), false);',
    },
    {
      id: 'c_40', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `createUnionFind(n: number)` returning `{ find(x: number): number; union(a: number, b: number): boolean; connected(a: number, b: number): boolean }` (union returns true if merged).',
      function_name: 'createUnionFind',
      assertion_script: 'const uf=createUnionFind(4); assert.strictEqual(uf.union(0,1), true); assert.strictEqual(uf.union(1,2), true); assert.strictEqual(uf.connected(0,2), true); assert.strictEqual(uf.connected(0,3), false); assert.strictEqual(uf.union(0,2), false);',
    },
    {
      id: 'c_41', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `binarySearchBounds(nums: number[], target: number): [number, number]` returning first and last index of target or [-1, -1].',
      function_name: 'binarySearchBounds',
      assertion_script: 'assert.deepStrictEqual(binarySearchBounds([5,7,7,8,8,10], 8), [3,4]); assert.deepStrictEqual(binarySearchBounds([5,7,7,8,8,10], 6), [-1,-1]);',
    },
    {
      id: 'c_42', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `countSubarraysSumK(nums: number[], k: number): number` counting contiguous subarrays summing to k.',
      function_name: 'countSubarraysSumK',
      assertion_script: 'assert.strictEqual(countSubarraysSumK([1,1,1], 2), 2); assert.strictEqual(countSubarraysSumK([1,2,3], 3), 2);',
    },
    {
      id: 'c_43', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `coinChangeMin(coins: number[], amount: number): number` returning minimum coins to make amount or -1.',
      function_name: 'coinChangeMin',
      assertion_script: 'assert.strictEqual(coinChangeMin([1,2,5], 11), 3); assert.strictEqual(coinChangeMin([2], 3), -1); assert.strictEqual(coinChangeMin([1], 0), 0);',
    },
    {
      id: 'c_44', category: 'code', difficulty: 'medium',
      query: 'Write a TypeScript function `runLengthEncode(s: string): string` encoding consecutive chars like "aaabbc" -> "a3b2c1" (empty -> "").',
      function_name: 'runLengthEncode',
      assertion_script: 'assert.strictEqual(runLengthEncode("aaabbc"), "a3b2c1"); assert.strictEqual(runLengthEncode(""), "");',
    },
    {
      id: 'c_45', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `romanToInt(s: string): number` converting Roman numerals like "MCMXCIV" to integers.',
      function_name: 'romanToInt',
      assertion_script: 'assert.strictEqual(romanToInt("III"), 3); assert.strictEqual(romanToInt("MCMXCIV"), 1994);',
    },
    {
      id: 'c_46', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `longestUniqueSubstring(s: string): number` returning length of longest substring without repeating characters.',
      function_name: 'longestUniqueSubstring',
      assertion_script: 'assert.strictEqual(longestUniqueSubstring("abcabcbb"), 3); assert.strictEqual(longestUniqueSubstring("bbbbb"), 1); assert.strictEqual(longestUniqueSubstring("pwwkew"), 3);',
    },
    {
      id: 'c_47', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `wordFrequency(text: string): Record<string, number>` lowercasing words stripped of punctuation [a-z0-9]+.',
      function_name: 'wordFrequency',
      assertion_script: 'assert.deepStrictEqual(wordFrequency("Hello, hello world!"), { hello: 2, world: 1 });',
    },
    {
      id: 'c_48', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `spiralOrder(matrix: number[][]): number[]` returning matrix elements in clockwise spiral order.',
      function_name: 'spiralOrder',
      assertion_script: 'assert.deepStrictEqual(spiralOrder([[1,2,3],[4,5,6],[7,8,9]]), [1,2,3,6,9,8,7,4,5]);',
    },
    {
      id: 'c_49', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `isAnagram(a: string, b: string): boolean` returning true if a and b are anagrams ignoring case and spaces.',
      function_name: 'isAnagram',
      assertion_script: 'assert.strictEqual(isAnagram("Listen", "Silent"), true); assert.strictEqual(isAnagram("hello", "world"), false);',
    },
    {
      id: 'c_50', category: 'code', difficulty: 'hard',
      query: 'Write a TypeScript function `productExceptSelf(nums: number[]): number[]` returning an array where output[i] is product of all elements except nums[i].',
      function_name: 'productExceptSelf',
      assertion_script: 'assert.deepStrictEqual(productExceptSelf([1,2,3,4]), [24,12,8,6]);',
    },
  ],
  extraction: [
    {
      id: 'e_1', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `name`, `email`, `phone` from: "Jane Doe | Senior Architect | Email: jane.doe@acme.io | Tel: +1-555-0192".',
      expected_json: { name: 'Jane Doe', email: 'jane.doe@acme.io', phone: '+1-555-0192' },
    },
    {
      id: 'e_2', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `date`, `total`, `tax` (numbers for total/tax) from SMS: "Receipt 2026-04-12: Cafe Nova Total $48.50 incl. Tax $4.10".',
      expected_json: { date: '2026-04-12', total: 48.5, tax: 4.1 },
    },
    {
      id: 'e_3', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `flight_number`, `departure_iata`, `arrival_iata` from: "Booking Confirmed: Flight BA-247 departing LHR at 10:15, arriving JFK at 13:05".',
      expected_json: { flight_number: 'BA-247', departure_iata: 'LHR', arrival_iata: 'JFK' },
    },
    {
      id: 'e_4', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `client_ip`, `method`, `status` (number) from log: `192.168.14.8 - "POST /api/v2/orders HTTP/1.1" 201 42ms`.',
      expected_json: { client_ip: '192.168.14.8', method: 'POST', status: 201 },
    },
    {
      id: 'e_5', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `invoice_id`, `currency`, `net_amount` (number) from: "INV-9941 | Currency: EUR | Subtotal 1200.00 | VAT Exempt Art.138 | Net Payable: 1200.00".',
      expected_json: { invoice_id: 'INV-9941', currency: 'EUR', net_amount: 1200 },
    },
    {
      id: 'e_6', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `governing_law`, `arbitration_venue`, `cap_usd` (number) from: "Governed by laws of Delaware; disputes resolved via arbitration in London; liability cap $250000.".',
      expected_json: { governing_law: 'Delaware', arbitration_venue: 'London', cap_usd: 250000 },
    },
    {
      id: 'e_7', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `bp`, `hr` (number), `spo2` (number) from triage note: "Patient vitals: BP 128/82 mmHg, HR 76 bpm, SpO2 98%, Temp 36.8C.".',
      expected_json: { bp: '128/82', hr: 76, spo2: 98 },
    },
    {
      id: 'e_8', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `file_path`, `branch_head`, `incoming_branch` from: "CONFLICT in src/router.ts between HEAD (a1b2c3d) and feature/rate-limit".',
      expected_json: { file_path: 'src/router.ts', branch_head: 'a1b2c3d', incoming_branch: 'feature/rate-limit' },
    },
    {
      id: 'e_9', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `parcel_id`, `sqft` (number), `bedrooms` (number) from deed: "Parcel #PN-40291 | Area: 0.45 acres | Living Space: 2450 sqft | 4 Bedrooms | Tax Year 2025".',
      expected_json: { parcel_id: 'PN-40291', sqft: 2450, bedrooms: 4 },
    },
    {
      id: 'e_10', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `user`, `verb`, `namespace` from K8s audit: "user=system:serviceaccount:ci:deployer verb=patch namespace=prod-core object=Deployment decision=allow".',
      expected_json: { user: 'system:serviceaccount:ci:deployer', verb: 'patch', namespace: 'prod-core' },
    },
    {
      id: 'e_11', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `revenue_millions` (number), `diluted_eps` (number), `tax_rate_pct` (number) from 10-K: "Q3 Net Revenues $842.5M, Operating Cash Flow $210M, Diluted EPS $1.42, Effective Tax Rate 21.5%.".',
      expected_json: { revenue_millions: 842.5, diluted_eps: 1.42, tax_rate_pct: 21.5 },
    },
    {
      id: 'e_12', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `cas_number`, `flash_point_c` (number), `hazard_class` from SDS: "Chemical: Acetone | CAS: 67-64-1 | Flash Point: -20 C | GHS Class: Flammable Liquid".',
      expected_json: { cas_number: '67-64-1', flash_point_c: -20, hazard_class: 'Flammable Liquid' },
    },
    {
      id: 'e_13', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `doi`, `year` (number), `first_author` from citation: "Vaswani et al. (2017). Attention Is All You Need. DOI: 10.5555/3295222.3295349".',
      expected_json: { doi: '10.5555/3295222.3295349', year: 2017, first_author: 'Vaswani' },
    },
    {
      id: 'e_14', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `error`, `state`, `error_description` from redirect URI: "https://app.example/cb?error=access_denied&error_description=User+cancelled&state=st_9921".',
      expected_json: { error: 'access_denied', state: 'st_9921', error_description: 'User' },
    },
    {
      id: 'e_15', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `vin`, `odometer_km` (number), `dtc_code` from telemetry: "VIN: 1HGCM82633A004352 | Odometer: 84120 km | Fuel: 62% | Active DTC: P0420".',
      expected_json: { vin: '1HGCM82633A004352', odometer_km: 84120, dtc_code: 'P0420' },
    },
    {
      id: 'e_16', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `domain`, `ttl` (number), `record_type`, `target` from zone entry: "api.example.org. 300 IN CNAME edge-01.cdn.net.".',
      expected_json: { domain: 'api.example.org', ttl: 300, record_type: 'CNAME', target: 'edge-01.cdn.net' },
    },
    {
      id: 'e_17', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `bol_number`, `scac`, `port_of_loading` from BOL: "B/L No: MAEU-7748102 | Carrier SCAC: MAEU | Vessel IMO: 9778810 | POL: Rotterdam | Seal: SL-908".',
      expected_json: { bol_number: 'MAEU-7748102', scac: 'MAEU', port_of_loading: 'Rotterdam' },
    },
    {
      id: 'e_18', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `check_in`, `check_out`, `nightly_rate` (number) from folio: "Check-in: 2026-07-01 | Check-out: 2026-07-04 | Rate: $189.00/night | Tier: Gold".',
      expected_json: { check_in: '2026-07-01', check_out: '2026-07-04', nightly_rate: 189 },
    },
    {
      id: 'e_19', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `years_experience` (number), `university`, `latest_title` from resume: "Alex Kim — 7 years experience. B.S. CS, Stanford University. Currently Staff Backend Engineer at CloudScale.".',
      expected_json: { years_experience: 7, university: 'Stanford University', latest_title: 'Staff Backend Engineer' },
    },
    {
      id: 'e_20', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `freq`, `interval` (number), `byday` from RRULE: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T235959Z".',
      expected_json: { freq: 'WEEKLY', interval: 2, byday: 'MO,WE' },
    },
    {
      id: 'e_21', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `drug`, `dosage_mg` (number), `refills` (number) from Rx: "Medication: Metformin HCl | Dose: 500 mg PO BID | Refills: 3".',
      expected_json: { drug: 'Metformin', dosage_mg: 500, refills: 3 },
    },
    {
      id: 'e_22', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `alg`, `iss`, `sub` from JWT details: "Header {alg: ES256, typ: JWT} Claims {iss: auth.ael.dev, sub: usr_8841, exp: 1800000000}".',
      expected_json: { alg: 'ES256', iss: 'auth.ael.dev', sub: 'usr_8841' },
    },
    {
      id: 'e_23', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `sender_bic`, `currency`, `amount` (number) from MT103: ":20:REF99812 :32A:260510USD45200,50 :50K:ACME CORP :52A:CHASUS33 :57A:DEUTDEFF".',
      expected_json: { sender_bic: 'CHASUS33', currency: 'USD', amount: 45200.5 },
    },
    {
      id: 'e_24', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `message_id`, `spf`, `subject` from headers: "Message-ID: <abc123@mail.test> | Authentication-Results: spf=pass dkim=pass | Subject: Quarterly Audit".',
      expected_json: { message_id: 'abc123@mail.test', spf: 'pass', subject: 'Quarterly Audit' },
    },
    {
      id: 'e_25', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `table_number` (number), `guest_count` (number), `timestamp` from POS ticket: "Table #14 | Guests: 4 | 2x Ramen, 2x Tea | Kitchen Sent: 19:42:10".',
      expected_json: { table_number: 14, guest_count: 4, timestamp: '19:42:10' },
    },
    {
      id: 'e_26', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `event_name`, `aws_region`, `source_ip` from CloudTrail: "eventName=AssumeRole awsRegion=us-east-1 sourceIPAddress=203.0.113.44 userIdentity=arn:aws:iam::123:user/ops".',
      expected_json: { event_name: 'AssumeRole', aws_region: 'us-east-1', source_ip: '203.0.113.44' },
    },
    {
      id: 'e_27', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `application_number`, `filing_date`, `ipc` from patent: "App No: US18/441,209 | Filed: 2025-02-18 | IPC: G06N 20/00".',
      expected_json: { application_number: 'US18/441,209', filing_date: '2025-02-18', ipc: 'G06N 20/00' },
    },
    {
      id: 'e_28', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `image`, `host_port` (number), `restart_policy` from container summary: "Image: nginx:1.27-alpine | Ports: 8080->80/tcp | RestartPolicy: unless-stopped".',
      expected_json: { image: 'nginx:1.27-alpine', host_port: 8080, restart_policy: 'unless-stopped' },
    },
    {
      id: 'e_29', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `reason_code`, `card_brand`, `arn` from chargeback: "Dispute Reason: 10.4 | Brand: Visa | ARN: 74518902114 | TxDate: 2026-03-01".',
      expected_json: { reason_code: '10.4', card_brand: 'Visa', arn: '74518902114' },
    },
    {
      id: 'e_30', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `nct_id`, `phase`, `sample_size` (number) from trial: "Registry: NCT05912844 | Study Phase: Phase 3 | Enrollment: 640 participants | Primary Outcome: Overall Survival".',
      expected_json: { nct_id: 'NCT05912844', phase: 'Phase 3', sample_size: 640 },
    },
    {
      id: 'e_31', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `kwh_used` (number), `amount_due` (number), `account_id` from bill: "Account: UTIL-7721 | Usage: 615 kWh | Peak Demand: 4.2 kW | Amount Due: $92.40".',
      expected_json: { kwh_used: 615, amount_due: 92.4, account_id: 'UTIL-7721' },
    },
    {
      id: 'e_32', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `ttl` (number), `protocol`, `tcp_flags` from packet summary: "Eth 00:1a:2b->ff:ff | IPv4 TTL=64 Proto=TCP | Flags=[SYN,ACK] Len=60".',
      expected_json: { ttl: 64, protocol: 'TCP', tcp_flags: 'SYN,ACK' },
    },
    {
      id: 'e_33', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `track`, `speaker`, `room` from agenda: "Track: Distributed Systems | Speaker: Dr. Maya Lin | Room: Hall B | 14:00-14:45".',
      expected_json: { track: 'Distributed Systems', speaker: 'Maya Lin', room: 'Hall B' },
    },
    {
      id: 'e_34', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `cart_id`, `promo_code`, `total_usd` (number) from webhook: "cart_uuid=crt_5501 customer=sam@shop.io items=3 promo=SAVE20 total=$119.20".',
      expected_json: { cart_id: 'crt_5501', promo_code: 'SAVE20', total_usd: 119.2 },
    },
    {
      id: 'e_35', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `hemoglobin` (number), `wbc` (number), `platelets` (number) from lab report: "CBC Results: Hemoglobin 14.2 g/dL, WBC 6.8 K/uL, Platelets 245 K/uL (all normal).".',
      expected_json: { hemoglobin: 14.2, wbc: 6.8, platelets: 245 },
    },
    {
      id: 'e_36', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `table_name`, `primary_key`, `column_count` (number) from DDL: "CREATE TABLE invoices (id UUID PRIMARY KEY, customer_id TEXT NOT NULL, amount_cents INTEGER NOT NULL);".',
      expected_json: { table_name: 'invoices', primary_key: 'id', column_count: 3 },
    },
    {
      id: 'e_37', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `policy_number`, `new_limit_usd` (number), `effective_date` from endorsement: "Policy #POL-33198 | Insured: Apex Logistics | Limit increased to $2000000 effective 2026-06-01".',
      expected_json: { policy_number: 'POL-33198', new_limit_usd: 2000000, effective_date: '2026-06-01' },
    },
    {
      id: 'e_38', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `station`, `wind_knots` (number), `temp_c` (number) from METAR: "METAR KJFK 141251Z 29018KT 10SM FEW045 19/08 A3012".',
      expected_json: { station: 'KJFK', wind_knots: 18, temp_c: 19 },
    },
    {
      id: 'e_39', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `role_title`, `salary_min` (number), `remote` (boolean) from job post: "Role: Principal SRE | Comp: $185,000 - $220,000 | Remote: true | Manager: VP Infra".',
      expected_json: { role_title: 'Principal SRE', salary_min: 185000, remote: true },
    },
    {
      id: 'e_40', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `remote_addr`, `status` (number), `bytes_sent` (number) from Nginx log: `10.0.4.22 - - [14/Nov/2026:10:15:02 +0000] "GET /healthz HTTP/1.1" 200 18 "-"`.',
      expected_json: { remote_addr: '10.0.4.22', status: 200, bytes_sent: 18 },
    },
    {
      id: 'e_41', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `appraised_value` (number), `gla_sqft` (number), `license_id` from report: "Fair Market Value: $675,000 | Gross Living Area: 2180 sq ft | Appraiser License: CA-AR09412".',
      expected_json: { appraised_value: 675000, gla_sqft: 2180, license_id: 'CA-AR09412' },
    },
    {
      id: 'e_42', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `repo`, `pr_number` (number), `base_branch`, `author` from webhook: "PR #418 on org/ael-core by @alice: merge feat/c2 into main (mergeable: clean)".',
      expected_json: { repo: 'org/ael-core', pr_number: 418, base_branch: 'main', author: 'alice' },
    },
    {
      id: 'e_43', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `serial_number`, `failure_code`, `repair_hours` (number) from work order: "Asset SN: COMP-88412 | Fault: ERR_BEARING_04 | Tech: E-209 | Labor: 3.5 hrs".',
      expected_json: { serial_number: 'COMP-88412', failure_code: 'ERR_BEARING_04', repair_hours: 3.5 },
    },
    {
      id: 'e_44', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `common_name`, `issuer`, `not_after` from X.509 summary: "Subject: CN=gateway.ael.io | Issuer: Let\'s Encrypt R11 | Valid: 2026-09-01 to 2026-11-30".',
      expected_json: { common_name: 'gateway.ael.io', issuer: "Let's Encrypt", not_after: '2026-11-30' },
    },
    {
      id: 'e_45', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `course_code`, `credits` (number), `gpa` (number) from transcript: "CS-401 Operating Systems | Credits: 4 | Grade: A | Cumulative GPA: 3.88".',
      expected_json: { course_code: 'CS-401', credits: 4, gpa: 3.88 },
    },
    {
      id: 'e_46', category: 'extraction', difficulty: 'medium',
      query: 'Extract JSON with keys `source_wh`, `dest_wh`, `pallet_count` (number) from transfer: "Transfer #TR-882: From WH-ORD-01 to WH-LAX-04 | 18 Pallets | Status: In Transit".',
      expected_json: { source_wh: 'WH-ORD-01', dest_wh: 'WH-LAX-04', pallet_count: 18 },
    },
    {
      id: 'e_47', category: 'extraction', difficulty: 'simple',
      query: 'Extract JSON with keys `permit_id`, `grade`, `risk_category` from inspection: "Permit #HD-10294 | Risk: High | Violations: 0 critical | Grade: A".',
      expected_json: { permit_id: 'HD-10294', grade: 'A', risk_category: 'High' },
    },
    {
      id: 'e_48', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `alertname`, `severity`, `instance` from Prometheus alert: "alertname=HighMemoryPressure severity=critical instance=10.2.8.14:9100 activeSince=2026-11-14T01:20:00Z".',
      expected_json: { alertname: 'HighMemoryPressure', severity: 'critical', instance: '10.2.8.14:9100' },
    },
    {
      id: 'e_49', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `entry_number`, `hts_code`, `entered_value` (number) from CBP 7501: "Entry No: 991-0448120-2 | Origin: JP | Port: 2704 | HTS: 8471.50.0150 | Value: $18400".',
      expected_json: { entry_number: '991-0448120-2', hts_code: '8471.50.0150', entered_value: 18400 },
    },
    {
      id: 'e_50', category: 'extraction', difficulty: 'hard',
      query: 'Extract JSON with keys `issuer`, `rating`, `outlook` from credit report: "Issuer: Meridian Power Corp | Senior Unsecured Rating: A- | Outlook: Stable | Watch: None".',
      expected_json: { issuer: 'Meridian Power Corp', rating: 'A-', outlook: 'Stable' },
    },
  ],
};

function get50Queries(category: 'factual' | 'math' | 'code' | 'extraction'): EvalQueryCase[] {
  return DISTINCT_BUDGET_QUERIES[category];
}

function getTestCasesForSplit(split: 'held_out' | 'tuning'): EvalQueryCase[] {
  const categories: Array<'factual' | 'math' | 'code' | 'extraction'> = ['factual', 'math', 'code', 'extraction'];
  return split === 'held_out'
    ? categories.flatMap(c => get50Queries(c))
    : [
        DISTINCT_BUDGET_QUERIES.factual[0],
        DISTINCT_BUDGET_QUERIES.math[0],
        DISTINCT_BUDGET_QUERIES.code[0],
        DISTINCT_BUDGET_QUERIES.extraction[0],
      ];
}

export function buildLiveGeminiBudgetProfile(): ProviderProfile {
  return {
    name: 'live_gemini',
    type: 'gemini',
    api_key_env: 'GEMINI_API_KEY',
    default_model: 'gemini-2.5-flash',
    cheap_model: 'gemini-2.5-flash-lite',
    reasoning_model: 'gemini-2.5-pro',
    supports_reasoning_effort: true,
    supports_logprobs: false,
    input_cost_per_million: 0.10,
    output_cost_per_million: 0.40,
    reasoning_cost_per_million: 0.40,
  };
}

export function projectBudgetEvalCost(
  split: 'held_out' | 'tuning' = 'held_out',
  provider: ProviderProfile = buildLiveGeminiBudgetProfile()
) {
  const testCases = getTestCasesForSplit(split);
  // Accounts for baseline pass-through + AEL probe/escalation + factual LLM judge checks
  return estimateProjectedEvalCost({
    queries: testCases.map(t => t.query),
    promptOverheadCharsPerCall: 140,
    callsPerQuery: 3.5,
    estimatedOutputTokensPerCall: 250,
    estimatedReasoningTokensPerCall: 350,
    provider,
  });
}

async function verifyCaseOutput(
  tc: EvalQueryCase,
  responseText: string,
  llm: LLMClient
): Promise<{ passed: boolean; method: VerificationMethod; extraCostUsd: number }> {
  if (tc.category === 'math') {
    const res = verifyMathNumericMatch(responseText, tc.expected_number!, tc.tolerance ?? 0.01);
    return { passed: res.passed, method: res.method, extraCostUsd: 0 };
  }
  if (tc.category === 'code') {
    const res = verifyCodeAssertionExecution(responseText, tc.function_name!, tc.assertion_script!);
    return { passed: res.passed, method: res.method, extraCostUsd: 0 };
  }
  if (tc.category === 'extraction') {
    const res = verifyExtractionJsonFields(responseText, tc.expected_json!);
    return { passed: res.passed, method: res.method, extraCostUsd: 0 };
  }

  // factual / reasoning: explicit LLM judge verdict against reference answer
  const judgeOut = await verifyReasoningJudgeVerdict(llm, tc.query, tc.expected_sub || '', responseText);
  return { passed: judgeOut.result.passed, method: judgeOut.result.method, extraCostUsd: judgeOut.judgeCostUsd };
}

export async function runBudgetEvalSuite(
  logStore: DecisionLogStore,
  split: 'held_out' | 'tuning' = 'held_out',
  options: BudgetEvalOptions = {}
): Promise<BudgetEvalResult> {
  const liveMode = Boolean(options.live || process.env.AEL_LIVE_EVAL === '1');
  const maxCostUsd = options.maxCostUsd ?? Number(process.env.AEL_MAX_EVAL_COST_USD || MAX_LIVE_EVAL_COST_USD);

  let hasLiveApiKey = false;
  let providerType: 'openai' | 'anthropic' | 'gemini' | 'mock' = 'mock';

  if (liveMode) {
    assertValidGeminiKey(process.env.GEMINI_API_KEY);
    hasLiveApiKey = true;
    providerType = 'gemini';
  } else {
    hasLiveApiKey = Boolean(
      (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' && process.env.GEMINI_API_KEY !== 'YOUR_API_KEY') ||
      (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'MY_API_KEY' && process.env.OPENAI_API_KEY !== 'YOUR_API_KEY') ||
      (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'MY_API_KEY' && process.env.ANTHROPIC_API_KEY !== 'YOUR_API_KEY')
    );

    providerType = hasLiveApiKey
      ? (process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'gemini')
      : 'mock';
  }

  const provider: ProviderProfile = liveMode
    ? buildLiveGeminiBudgetProfile()
    : {
        name: hasLiveApiKey ? `live_${providerType}` : 'smoke_mock',
        type: providerType,
        api_key_env: providerType === 'openai' ? 'OPENAI_API_KEY' : providerType === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY',
        default_model: providerType === 'openai' ? 'gpt-4o-mini' : providerType === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gemini-2.5-flash',
        cheap_model: providerType === 'openai' ? 'gpt-4o-mini' : providerType === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gemini-2.5-flash-lite',
        reasoning_model: providerType === 'openai' ? 'o3-mini' : providerType === 'anthropic' ? 'claude-3-7-sonnet-20250219' : 'gemini-2.5-pro',
        supports_reasoning_effort: true,
        supports_logprobs: true,
        input_cost_per_million: 0.15,
        output_cost_per_million: 0.60,
        reasoning_cost_per_million: 0.60,
      };

  const projected = projectBudgetEvalCost(split, provider);
  if (liveMode || options.maxCostUsd !== undefined) {
    assertWithinSpendingGuard(projected.projectedCostUsd, maxCostUsd, `budget_eval_suite(${split}):preflight`);
  }

  const llm = new LLMClient(provider);
  const circuitBreaker = new CircuitBreakerController(
    { enabled: true, rolling_window: 20, min_net_savings_usd: 0, max_error_rate: 0.2 },
    logStore
  );
  const engine = new BudgetEngine(llm, logStore, circuitBreaker, DEFAULT_PRESETS.balanced);

  const testCases = getTestCasesForSplit(split);

  const catMethods: Record<'factual' | 'math' | 'code' | 'extraction', VerificationMethod> = {
    factual: 'judge_verdict',
    math: 'numeric_match',
    code: 'code_execution',
    extraction: 'json_field_match',
  };

  const catStats: Record<
    string,
    { baselineTok: number; actualTok: number; baseCost: number; actCost: number; baseCorrect: number; correct: number; total: number; overheads: number[] }
  > = {
    factual: { baselineTok: 0, actualTok: 0, baseCost: 0, actCost: 0, baseCorrect: 0, correct: 0, total: 0, overheads: [] },
    math: { baselineTok: 0, actualTok: 0, baseCost: 0, actCost: 0, baseCorrect: 0, correct: 0, total: 0, overheads: [] },
    code: { baselineTok: 0, actualTok: 0, baseCost: 0, actCost: 0, baseCorrect: 0, correct: 0, total: 0, overheads: [] },
    extraction: { baselineTok: 0, actualTok: 0, baseCost: 0, actCost: 0, baseCorrect: 0, correct: 0, total: 0, overheads: [] },
  };

  let cumulativeCostUsd = 0;

  for (const tc of testCases) {
    const categoryKey = tc.category;

    // 1. Measure real baseline output (fixed high reasoning effort, no adaptive AEL routing)
    const baselineRes = await llm.complete(tc.query, { reasoning_effort: 'high' });
    cumulativeCostUsd += baselineRes.cost_usd;

    // 2. Measure AEL routed output against measured reference baseline
    const res = await engine.routeAndExecute(tc.query, {
      workflow_id: `eval_${split}`,
      task_category: categoryKey,
      policy: DEFAULT_PRESETS.balanced,
      reference_baseline: {
        total_tokens: baselineRes.total_tokens,
        cost_usd: baselineRes.cost_usd,
      },
    });
    cumulativeCostUsd += res.total_cost_usd;

    // 3. Apply identical real per-category verifier to both baseline and AEL responses
    const baseCheck = await verifyCaseOutput(tc, baselineRes.text, llm);
    const aelCheck = await verifyCaseOutput(tc, res.text, llm);
    cumulativeCostUsd += baseCheck.extraCostUsd + aelCheck.extraCostUsd;

    if (liveMode || options.maxCostUsd !== undefined) {
      assertWithinSpendingGuard(cumulativeCostUsd, maxCostUsd, `budget_eval_suite(${split}):runtime`);
    }

    const stat = catStats[categoryKey];
    if (stat) {
      stat.total++;
      stat.baselineTok += res.baseline_tokens;
      stat.actualTok += res.total_tokens;
      stat.baseCost += res.baseline_cost_usd;
      stat.actCost += res.total_cost_usd;
      stat.overheads.push(res.ael_overhead_ms);
      if (baseCheck.passed) stat.baseCorrect++;
      if (aelCheck.passed) stat.correct++;
    }
  }

  const categoryResults: Record<string, CategoryMetric> = {};
  let totalBaseTok = 0;
  let totalActTok = 0;
  let totalBaseCost = 0;
  let totalActCost = 0;
  let totalBaseCorrect = 0;
  let totalCorrect = 0;
  let allOverheads: number[] = [];

  for (const [cat, stat] of Object.entries(catStats)) {
    if (stat.total === 0) continue;
    const tokenReduct = ((stat.baselineTok - stat.actualTok) / stat.baselineTok) * 100;
    const netSavedUsd = Number((stat.baseCost - stat.actCost).toFixed(5));
    const acc = Number((stat.correct / stat.total).toFixed(4));
    const baselineAcc = Number((stat.baseCorrect / stat.total).toFixed(4));
    const accDelta = Number(((acc - baselineAcc) * 100).toFixed(1));

    stat.overheads.sort((a, b) => a - b);
    const p95 = stat.overheads[Math.floor(stat.overheads.length * 0.95)] ?? 0;

    categoryResults[cat] = {
      category: cat,
      verification_method: catMethods[cat as keyof typeof catMethods],
      total_samples: stat.total,
      baseline_tokens: stat.baselineTok,
      actual_tokens: stat.actualTok,
      token_reduction_ratio: `${stat.baselineTok - stat.actualTok}/${stat.baselineTok}`,
      token_reduction_pct: Number(tokenReduct.toFixed(1)),
      baseline_cost_usd: Number(stat.baseCost.toFixed(5)),
      actual_cost_usd: Number(stat.actCost.toFixed(5)),
      net_cost_saved_usd: netSavedUsd,
      baseline_correct: stat.baseCorrect,
      baseline_accuracy_ratio: `${stat.baseCorrect}/${stat.total}`,
      baseline_accuracy: baselineAcc,
      actual_correct: stat.correct,
      accuracy_ratio: `${stat.correct}/${stat.total}`,
      accuracy: acc,
      accuracy_delta_pp: accDelta,
      p95_overhead_ms: p95,
    };

    totalBaseTok += stat.baselineTok;
    totalActTok += stat.actualTok;
    totalBaseCost += stat.baseCost;
    totalActCost += stat.actCost;
    totalBaseCorrect += stat.baseCorrect;
    totalCorrect += stat.correct;
    allOverheads = allOverheads.concat(stat.overheads);
  }

  allOverheads.sort((a, b) => a - b);
  const overallP95 = allOverheads[Math.floor(allOverheads.length * 0.95)] ?? 0;
  const overallTokenReduct = ((totalBaseTok - totalActTok) / totalBaseTok) * 100;
  const overallNetSavings = Number((totalBaseCost - totalActCost).toFixed(5));
  const usdPerTaskBaseline = Number((totalBaseCost / testCases.length).toFixed(5));
  const usdPerTaskAel = Number((totalActCost / testCases.length).toFixed(5));
  const overallAcc = Number((totalCorrect / testCases.length).toFixed(4));
  const baselineOverallAcc = Number((totalBaseCorrect / testCases.length).toFixed(4));
  const accuracyDropPp = Math.max(0, Number(((baselineOverallAcc - overallAcc) * 100).toFixed(1)));

  const acceptanceStatus = hasLiveApiKey
    ? (overallTokenReduct >= 50.0 && accuracyDropPp <= 2.0 ? 'PASS' : 'NOT VALIDATED (Thresholds not reached)')
    : 'NOT VALIDATED (No live upstream API credentials configured)';

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const result: BudgetEvalResult = {
    suite_name: `AERA/CoBa Thinking Budget Comparative Benchmark (${split.toUpperCase()})`,
    benchmark_type: 'comparative_benchmark_identical_samples',
    benchmark_methodology:
      'Separate comparative benchmark running fixed high-effort baseline vs AEL BudgetEngine on identical samples; live per-request proxy accounting reports actual consumption only.',
    split,
    timestamp: now.toISOString(),
    execution_date: dateStr,
    run_command: liveMode
      ? `npx tsx bin/ael.ts eval --suite budget --split ${split} --live`
      : `npx tsx bin/ael.ts eval --suite budget --split ${split}`,
    live_api_credentials_present: hasLiveApiKey,
    provider_source: hasLiveApiKey ? providerType : 'mock_simulator',
    acceptance_status: acceptanceStatus,
    total_queries: testCases.length,
    overall_baseline_tokens: totalBaseTok,
    overall_actual_tokens: totalActTok,
    overall_token_reduction_ratio: `${totalBaseTok - totalActTok}/${totalBaseTok}`,
    overall_token_reduction_pct: Number(overallTokenReduct.toFixed(1)),
    overall_net_savings_usd: overallNetSavings,
    usd_per_task_baseline: usdPerTaskBaseline,
    usd_per_task_ael: usdPerTaskAel,
    overall_baseline_correct: totalBaseCorrect,
    overall_baseline_accuracy_ratio: `${totalBaseCorrect}/${testCases.length}`,
    baseline_accuracy: baselineOverallAcc,
    overall_actual_correct: totalCorrect,
    overall_accuracy_ratio: `${totalCorrect}/${testCases.length}`,
    overall_accuracy: overallAcc,
    accuracy_drop_pp: accuracyDropPp,
    overall_p95_overhead_ms: overallP95,
    categories: categoryResults,
  };

  // Persist evidence JSON to evals/results/
  const suiteDir = path.dirname(fileURLToPath(import.meta.url));
  const resultsDir = path.resolve(suiteDir, '..', 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const fileName = liveMode ? `${dateStr}_live_budget_${split}.json` : `${dateStr}_budget_${split}.json`;
  const evidenceFile = path.join(resultsDir, fileName);
  fs.writeFileSync(evidenceFile, JSON.stringify(result, null, 2), 'utf8');

  return result;
}
