/**
 * AEL — Agent Economics Layer
 * Provider-Agnostic LLM Adapter Layer
 * Supports OpenAI-compatible, Anthropic-style, Gemini, and Local Mock
 * Tracks input, output, reasoning tokens, and USD costs
 * Enforces graceful degradation when provider lacks reasoning knobs
 * @license Apache-2.0
 */

import { ProviderProfile } from '../config/ael_config.js';
import { GoogleGenAI, ThinkingConfig, ThinkingLevel } from '@google/genai';

export interface LLMRequestOptions {
  model?: string;
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high';
  temperature?: number;
  max_tokens?: number;
  system_instruction?: string;
}

export interface LLMResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  model: string;
  logprob_confidence?: number;
  confidence_source: 'provider_logprobs' | 'unavailable';
  provider_source: 'openai' | 'anthropic' | 'gemini' | 'mock_simulator';
}

export const MAX_GEMINI_RATE_LIMIT_ATTEMPTS = 5;
export const BASE_GEMINI_RETRY_DELAY_MS = 1000;

export function isGeminiRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    const str = String(err || '');
    return /\b429\b/.test(str) || /RESOURCE_EXHAUSTED/i.test(str);
  }
  const e = err as Record<string, any>;
  if (e.status === 429 || e.code === 429 || e.response?.status === 429 || e.error?.code === 429) {
    return true;
  }
  if (e.status === 'RESOURCE_EXHAUSTED' || e.error?.status === 'RESOURCE_EXHAUSTED') {
    return true;
  }
  const message = String(e.message || '');
  return /\b429\b/.test(message) || /RESOURCE_EXHAUSTED/i.test(message);
}

function parseDelayStringToMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.ceil(raw * 1000);
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, any>;
    const seconds = typeof obj.seconds === 'number' ? obj.seconds : Number(obj.seconds || 0);
    const nanos = typeof obj.nanos === 'number' ? obj.nanos : Number(obj.nanos || 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos) && (seconds > 0 || nanos > 0)) {
      return Math.ceil(seconds * 1000 + nanos / 1_000_000);
    }
    return null;
  }
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms' || unit.startsWith('millisecond')) {
    return Math.ceil(value);
  }
  return Math.ceil(value * 1000);
}

export function parseGeminiRetryInfoMs(err: unknown): number | null {
  if (!err) return null;

  // 1. Inspect structured RetryInfo details arrays if exposed on the error object
  const candidateDetails: any[] = [];
  if (typeof err === 'object') {
    const e = err as Record<string, any>;
    if (Array.isArray(e.details)) candidateDetails.push(...e.details);
    if (Array.isArray(e.errorDetails)) candidateDetails.push(...e.errorDetails);
    if (Array.isArray(e.error?.details)) candidateDetails.push(...e.error.details);
    if (Array.isArray(e.response?.data?.error?.details)) candidateDetails.push(...e.response.data.error.details);
  }
  for (const item of candidateDetails) {
    if (item && typeof item === 'object' && item.retryDelay !== undefined) {
      const parsed = parseDelayStringToMs(item.retryDelay);
      if (parsed !== null) return parsed;
    }
  }

  // 2. Inspect text / embedded JSON payload in error message
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const patterns: RegExp[] = [
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?(?:ms|s))"/i,
    /retryDelay\s*[:=]\s*["']?(\d+(?:\.\d+)?(?:ms|s))["']?/i,
    /Please retry in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)/i,
    /retry(?:\s+after|\s+in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)/i,
  ];

  for (const regex of patterns) {
    const m = msg.match(regex);
    if (m) {
      if (m[2]) {
        const parsed = parseDelayStringToMs(`${m[1]}${m[2]}`);
        if (parsed !== null) return parsed;
      } else if (m[1]) {
        const parsed = parseDelayStringToMs(m[1]);
        if (parsed !== null) return parsed;
      }
    }
  }

  return null;
}

export class LLMClient {
  private geminiClient: GoogleGenAI | null = null;
  private geminiInitError: Error | null = null;

  constructor(private profile: ProviderProfile) {
    if (profile.type === 'gemini') {
      const apiKey = process.env[profile.api_key_env] || process.env.GEMINI_API_KEY;
      if (apiKey && apiKey !== 'MY_GEMINI_API_KEY' && apiKey !== 'YOUR_API_KEY') {
        try {
          this.geminiClient = new GoogleGenAI({ apiKey });
        } catch (err: any) {
          this.geminiInitError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
  }

  public async complete(prompt: string, options: LLMRequestOptions = {}): Promise<LLMResponse> {
    const start = Date.now();
    const model = options.model || this.profile.default_model;
    const apiKey = process.env[this.profile.api_key_env];

    // Graceful degradation warning
    if (options.reasoning_effort && !this.profile.supports_reasoning_effort) {
      console.warn(
        `[AEL LLM Degradation] Provider '${this.profile.name}' does not expose reasoning effort knob '${options.reasoning_effort}'. Degraded gracefully without crashing.`
      );
    }

    // 1. OpenAI-Compatible Adapter (/v1/chat/completions)
    if (this.profile.type === 'openai') {
      if (!apiKey || apiKey === 'MY_API_KEY' || apiKey === 'YOUR_API_KEY') {
        throw new Error(
          `[AEL LLM] Missing API key for OpenAI provider '${this.profile.name}' (env '${this.profile.api_key_env}').`
        );
      }
      return await this.callOpenAI(prompt, model, options, apiKey, start);
    }

    // 2. Anthropic-Style Adapter (/v1/messages)
    if (this.profile.type === 'anthropic') {
      if (!apiKey || apiKey === 'MY_API_KEY' || apiKey === 'YOUR_API_KEY') {
        throw new Error(
          `[AEL LLM] Missing API key for Anthropic provider '${this.profile.name}' (env '${this.profile.api_key_env}').`
        );
      }
      return await this.callAnthropic(prompt, model, options, apiKey, start);
    }

    // 3. Gemini Adapter (@google/genai)
    if (this.profile.type === 'gemini') {
      if (this.geminiInitError) {
        throw new Error(
          `[AEL LLM] Gemini client initialization failed for provider '${this.profile.name}': ${this.geminiInitError.message}`
        );
      }
      if (!this.geminiClient) {
        throw new Error(
          `[AEL LLM] Missing or invalid Gemini API key for provider '${this.profile.name}' (env '${this.profile.api_key_env}').`
        );
      }
      return await this.callGemini(prompt, model, options, start);
    }

    // 4. Mock / Smoke-Test Simulator (Allowed ONLY with explicit AEL_ALLOW_MOCK=1 flag)
    if (this.profile.type === 'mock') {
      if (process.env.AEL_ALLOW_MOCK !== '1') {
        throw new Error(
          `[AEL LLM] Mock provider '${this.profile.name}' is disabled. Set AEL_ALLOW_MOCK=1 to run smoke tests or unit tests with mock_simulator.`
        );
      }
      return this.mockGenerate(prompt, model, options, start);
    }

    throw new Error(`[AEL LLM] Unsupported provider type: '${String(this.profile.type)}'.`);
  }

  private async callOpenAI(
    prompt: string,
    model: string,
    options: LLMRequestOptions,
    apiKey: string,
    startTime: number
  ): Promise<LLMResponse> {
    const baseUrl = (this.profile.base_url || 'https://api.openai.com/v1').replace(/\/$/, '');
    const body: Record<string, any> = {
      model,
      messages: [{ role: 'user', content: prompt }],
    };

    if (this.profile.supports_reasoning_effort && options.reasoning_effort && options.reasoning_effort !== 'none') {
      body.reasoning_effort = options.reasoning_effort;
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.max_tokens) body.max_tokens = options.max_tokens;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
    }

    const data: any = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    const input_tokens = usage.prompt_tokens || Math.ceil(prompt.length / 4);
    const output_tokens = usage.completion_tokens || Math.ceil(text.length / 4);
    const reasoning_tokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    const total_tokens = usage.total_tokens || input_tokens + output_tokens + reasoning_tokens;
    const latency_ms = Date.now() - startTime;
    const cost_usd = this.calculateCost(input_tokens, output_tokens, reasoning_tokens);

    const logprobContent = data.choices?.[0]?.logprobs?.content;
    let logprob_confidence: number | undefined;
    let confidence_source: 'provider_logprobs' | 'unavailable' = 'unavailable';
    if (Array.isArray(logprobContent) && logprobContent.length > 0) {
      const probs = logprobContent
        .map((item: any) => item?.logprob)
        .filter((lp: any) => typeof lp === 'number' && Number.isFinite(lp));
      if (probs.length > 0) {
        const avgProb = probs.reduce((acc: number, lp: number) => acc + Math.exp(lp), 0) / probs.length;
        logprob_confidence = Number(Math.min(1, Math.max(0, avgProb)).toFixed(4));
        confidence_source = 'provider_logprobs';
      }
    }

    return {
      text,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_usd,
      latency_ms,
      model,
      ...(logprob_confidence !== undefined ? { logprob_confidence } : {}),
      confidence_source,
      provider_source: 'openai',
    };
  }

  private async callAnthropic(
    prompt: string,
    model: string,
    options: LLMRequestOptions,
    apiKey: string,
    startTime: number
  ): Promise<LLMResponse> {
    const baseUrl = (this.profile.base_url || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    const body: Record<string, any> = {
      model,
      max_tokens: options.max_tokens || 1024,
      messages: [{ role: 'user', content: prompt }],
    };

    if (this.profile.supports_reasoning_effort && options.reasoning_effort === 'high') {
      body.thinking = { type: 'enabled', budget_tokens: 2048 };
    }

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
    }

    const data: any = await response.json();
    const text = data.content?.[0]?.text || '';
    const usage = data.usage || {};
    const input_tokens = usage.input_tokens || Math.ceil(prompt.length / 4);
    const output_tokens = usage.output_tokens || Math.ceil(text.length / 4);
    const reasoning_tokens = 0;
    const total_tokens = input_tokens + output_tokens;
    const latency_ms = Date.now() - startTime;
    const cost_usd = this.calculateCost(input_tokens, output_tokens, reasoning_tokens);

    return {
      text,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_usd,
      latency_ms,
      model,
      confidence_source: 'unavailable',
      provider_source: 'anthropic',
    };
  }

  private buildGeminiThinkingConfig(
    model: string,
    effort: 'none' | 'low' | 'medium' | 'high'
  ): ThinkingConfig {
    const useLevel =
      this.profile.gemini_thinking_mode === 'level' ||
      (this.profile.gemini_thinking_mode === undefined && /^gemini-3/i.test(model));

    if (useLevel) {
      const levelMap: Record<'none' | 'low' | 'medium' | 'high', ThinkingLevel> = {
        none: ThinkingLevel.MINIMAL,
        low: ThinkingLevel.LOW,
        medium: ThinkingLevel.MEDIUM,
        high: ThinkingLevel.HIGH,
      };
      return { thinkingLevel: levelMap[effort] };
    }

    const customBudgets = this.profile.gemini_thinking_budgets;
    const defaultBudgets: Record<'none' | 'low' | 'medium' | 'high', number> = {
      none: /2\.5-pro/i.test(model) ? 128 : 0,
      low: 512,
      medium: 2048,
      high: 8192,
    };

    const budget = customBudgets?.[effort] ?? defaultBudgets[effort];
    return { thinkingBudget: budget };
  }

  private async callGemini(
    prompt: string,
    model: string,
    options: LLMRequestOptions,
    startTime: number
  ): Promise<LLMResponse> {
    const config: Record<string, any> = {};
    if (options.temperature !== undefined) config.temperature = options.temperature;
    if (options.max_tokens !== undefined) config.maxOutputTokens = options.max_tokens;
    if (options.system_instruction) config.systemInstruction = options.system_instruction;

    if (this.profile.supports_reasoning_effort && options.reasoning_effort) {
      config.thinkingConfig = this.buildGeminiThinkingConfig(model, options.reasoning_effort);
    }

    let response: any;
    let lastRateLimitError: unknown;
    for (let attempt = 1; attempt <= MAX_GEMINI_RATE_LIMIT_ATTEMPTS; attempt++) {
      try {
        response = await this.geminiClient!.models.generateContent({
          model,
          contents: prompt,
          config,
        });
        break;
      } catch (err: unknown) {
        if (!isGeminiRateLimitError(err)) {
          throw err;
        }
        lastRateLimitError = err;
        if (attempt >= MAX_GEMINI_RATE_LIMIT_ATTEMPTS) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `[AEL LLM] Gemini 429 RESOURCE_EXHAUSTED exhausted after ${MAX_GEMINI_RATE_LIMIT_ATTEMPTS} attempts: ${msg}`
          );
        }

        const retryInfoMs = parseGeminiRetryInfoMs(err);
        const expBackoffMs = BASE_GEMINI_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        const delayMs = retryInfoMs !== null ? Math.max(retryInfoMs, expBackoffMs) : expBackoffMs;
        console.warn(
          `[AEL LLM Retry] Gemini 429 RESOURCE_EXHAUSTED on attempt ${attempt}/${MAX_GEMINI_RATE_LIMIT_ATTEMPTS} (${retryInfoMs !== null ? `RetryInfo=${retryInfoMs}ms` : 'RetryInfo=none'}). Backing off ${delayMs}ms before retry...`
        );
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      }
    }
    if (!response && lastRateLimitError) {
      throw lastRateLimitError instanceof Error ? lastRateLimitError : new Error(String(lastRateLimitError));
    }

    const text = response.text || '';
    const usage = (response as any).usageMetadata || {};
    const input_tokens =
      typeof usage.promptTokenCount === 'number' && Number.isFinite(usage.promptTokenCount)
        ? usage.promptTokenCount
        : Math.ceil(prompt.length / 4);
    const output_tokens =
      typeof usage.candidatesTokenCount === 'number' && Number.isFinite(usage.candidatesTokenCount)
        ? usage.candidatesTokenCount
        : Math.ceil(text.length / 4);
    // Gemini @google/genai reports thinking tokens in usageMetadata.thoughtsTokenCount;
    // fall back gracefully to reasoningTokenCount or 0 if omitted.
    const rawReasoningTokens =
      typeof usage.thoughtsTokenCount === 'number'
        ? usage.thoughtsTokenCount
        : typeof usage.reasoningTokenCount === 'number'
          ? usage.reasoningTokenCount
          : 0;
    const reasoning_tokens = Number.isFinite(rawReasoningTokens) && rawReasoningTokens > 0 ? rawReasoningTokens : 0;
    const total_tokens = Math.max(
      input_tokens + output_tokens + reasoning_tokens,
      typeof usage.totalTokenCount === 'number' && Number.isFinite(usage.totalTokenCount) ? usage.totalTokenCount : 0
    );
    const latency_ms = Date.now() - startTime;
    const cost_usd = this.calculateCost(input_tokens, output_tokens, reasoning_tokens);

    const avgLogprobs = (response as any).candidates?.[0]?.avgLogprobs;
    let logprob_confidence: number | undefined;
    let confidence_source: 'provider_logprobs' | 'unavailable' = 'unavailable';
    if (typeof avgLogprobs === 'number' && Number.isFinite(avgLogprobs) && avgLogprobs <= 0) {
      logprob_confidence = Number(Math.min(1, Math.max(0, Math.exp(avgLogprobs))).toFixed(4));
      confidence_source = 'provider_logprobs';
    }

    return {
      text,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_usd,
      latency_ms,
      model,
      ...(logprob_confidence !== undefined ? { logprob_confidence } : {}),
      confidence_source,
      provider_source: 'gemini',
    };
  }

  private mockGenerate(
    prompt: string,
    model: string,
    options: LLMRequestOptions,
    startTime: number
  ): LLMResponse {
    const latency_ms = Math.max(8, Math.min(60, Math.floor(prompt.length / 12)));
    const input_tokens = Math.ceil(prompt.length / 4);

    let reasoning_tokens = 0;
    if (options.reasoning_effort === 'high') {
      reasoning_tokens = 600;
    } else if (options.reasoning_effort === 'medium') {
      reasoning_tokens = 250;
    } else if (options.reasoning_effort === 'low') {
      reasoning_tokens = 80;
    }

    let text = '';
    if (prompt.includes('SELECT TOOL AND ARGUMENTS')) {
      const match = prompt.match(/SELECT TOOL AND ARGUMENTS[^\n]*\n"([^"]+)"/i) || prompt.match(/"([^"]+)"/);
      const userTask = (match ? match[1] : prompt).toLowerCase();

      if (
        userTask.includes('readme') ||
        userTask.includes('/workspace') ||
        userTask.includes('read file') ||
        (userTask.includes('read') &&
          (userTask.includes('file') ||
            userTask.includes('content') ||
            userTask.includes('documentation') ||
            userTask.includes('.md') ||
            userTask.includes('.ts') ||
            userTask.includes('source code')))
      ) {
        let p = '/workspace/README.md';
        if (userTask.includes('config.json')) p = '/workspace/config.json';
        else if (userTask.includes('index.ts')) p = '/workspace/src/index.ts';
        else if (userTask.includes('ghost_file')) p = '/workspace/ghost_file.txt';

        text = JSON.stringify({
          tool: 'fs_read_file',
          arguments: { path: p },
          reasoning: 'Reading file at path',
        });
      } else if (userTask.includes('sql') || userTask.includes('select') || userTask.includes('warehouse')) {
        text = JSON.stringify({
          tool: 'db_query_readonly',
          arguments: { sql: 'SELECT * FROM metrics' },
          reasoning: 'Querying database warehouse',
        });
      } else if (userTask.includes('transfer') || userTask.includes('funds') || userTask.includes('money')) {
        text = JSON.stringify({
          tool: 'fin_transfer_funds',
          arguments: { source_account: 'acc_001', target_account: 'acc_002', amount_usd: 50 },
          reasoning: 'Transferring funds',
        });
      } else if (userTask.includes('list') || userTask.includes('directory') || userTask.includes('folder') || userTask.includes('inspect files')) {
        text = JSON.stringify({
          tool: 'fs_list_directory',
          arguments: { path: '/workspace' },
          reasoning: 'Listing directory contents',
        });
      } else if (userTask.includes('search') || userTask.includes('find') || userTask.includes('query') || userTask.includes('doc') || userTask.includes('pricing policy')) {
        text = JSON.stringify({
          tool: 'search_knowledge_base',
          arguments: { query: 'economics layer' },
          reasoning: 'Searching knowledge base',
        });
      } else {
        text = JSON.stringify({
          tool: 'search_knowledge_base',
          arguments: { query: 'general search' },
          reasoning: 'Default tool action',
        });
      }
    } else if (prompt.includes('EVALUATE EVIDENCE') || prompt.includes('VERIFY')) {
      text = JSON.stringify({
        verified: true,
        confidence: 0.92,
        rationale: 'Answer is stable and matches criteria',
      });
    } else {
      text = `Processed response for query. Verified output.`;
    }

    const output_tokens = Math.ceil(text.length / 4);
    const total_tokens = input_tokens + output_tokens + reasoning_tokens;
    const cost_usd = this.calculateCost(input_tokens, output_tokens, reasoning_tokens);

    return {
      text,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_usd,
      latency_ms,
      model,
      confidence_source: 'unavailable',
      provider_source: 'mock_simulator',
    };
  }

  public calculateCost(inputTokens: number, outputTokens: number, reasoningTokens: number = 0): number {
    const inputCost = (inputTokens / 1_000_000) * this.profile.input_cost_per_million;
    const outputCost = (outputTokens / 1_000_000) * this.profile.output_cost_per_million;
    const reasoningCost = (reasoningTokens / 1_000_000) * this.profile.reasoning_cost_per_million;
    return Number((inputCost + outputCost + reasoningCost).toFixed(6));
  }
}
