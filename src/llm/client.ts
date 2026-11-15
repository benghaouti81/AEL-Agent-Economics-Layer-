/**
 * AEL — Agent Economics Layer
 * Provider-Agnostic LLM Adapter Layer
 * Supports OpenAI-compatible, Anthropic-style, and Gemini live providers
 * Tracks input, output, reasoning tokens, and USD costs
 * Enforces explicit credential, response, and token-usage validation (zero mock fallback)
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
  provider_source: 'openai' | 'anthropic' | 'gemini' | 'unit_test';
  usage_source: 'provider_reported' | 'unit_test';
}

export const MAX_GEMINI_RATE_LIMIT_ATTEMPTS = 5;
export const BASE_GEMINI_RETRY_DELAY_MS = 1000;

const PLACEHOLDER_KEYS = new Set([
  'MY_GEMINI_API_KEY',
  'MY_API_KEY',
  'YOUR_API_KEY',
  'YOUR_GEMINI_API_KEY',
  'YOUR_OPENAI_API_KEY',
  'YOUR_ANTHROPIC_API_KEY',
  'REPLACE_ME',
]);

export function isPlaceholderOrEmptyKey(rawKey?: string): boolean {
  const key = (rawKey || '').trim();
  return key.length === 0 || PLACEHOLDER_KEYS.has(key);
}

function assertNonNegativeFiniteTokenCount(value: unknown, fieldName: string, provider: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `[AEL LLM] Invalid ${provider} response: missing or invalid token usage field '${fieldName}'. Refusing to estimate or zero missing token counts.`
    );
  }
  return value;
}

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
  private geminiInitKey: string | null = null;

  constructor(private profile: ProviderProfile) {
    if (profile.type === 'gemini') {
      const apiKey = process.env[profile.api_key_env] || (profile.api_key_env === 'GEMINI_API_KEY' ? process.env.GEMINI_API_KEY : undefined);
      if (!isPlaceholderOrEmptyKey(apiKey)) {
        try {
          this.geminiClient = new GoogleGenAI({ apiKey: apiKey!.trim() });
          this.geminiInitKey = apiKey!.trim();
        } catch (err: any) {
          this.geminiInitError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
  }

  public getProfile(): ProviderProfile {
    return this.profile;
  }

  public async complete(prompt: string, options: LLMRequestOptions = {}): Promise<LLMResponse> {
    const start = Date.now();
    const model = options.model || this.profile.default_model;
    const apiKey = process.env[this.profile.api_key_env];

    // Graceful degradation warning when provider lacks reasoning knob
    if (options.reasoning_effort && !this.profile.supports_reasoning_effort) {
      console.warn(
        `[AEL LLM Degradation] Provider '${this.profile.name}' does not expose reasoning effort knob '${options.reasoning_effort}'. Degraded gracefully without crashing.`
      );
    }

    // 1. OpenAI-Compatible Adapter (/v1/chat/completions)
    if (this.profile.type === 'openai') {
      if (isPlaceholderOrEmptyKey(apiKey)) {
        throw new Error(
          `[AEL LLM] Missing API key for OpenAI provider '${this.profile.name}' (env '${this.profile.api_key_env}'). Live provider credentials are required.`
        );
      }
      return await this.callOpenAI(prompt, model, options, apiKey!.trim(), start);
    }

    // 2. Anthropic-Style Adapter (/v1/messages)
    if (this.profile.type === 'anthropic') {
      if (isPlaceholderOrEmptyKey(apiKey)) {
        throw new Error(
          `[AEL LLM] Missing API key for Anthropic provider '${this.profile.name}' (env '${this.profile.api_key_env}'). Live provider credentials are required.`
        );
      }
      return await this.callAnthropic(prompt, model, options, apiKey!.trim(), start);
    }

    // 3. Gemini Adapter (@google/genai)
    if (this.profile.type === 'gemini') {
      if (this.geminiInitError) {
        throw new Error(
          `[AEL LLM] Gemini client initialization failed for provider '${this.profile.name}': ${this.geminiInitError.message}`
        );
      }
      const envKey = apiKey || (this.profile.api_key_env === 'GEMINI_API_KEY' ? process.env.GEMINI_API_KEY : undefined);
      if (!isPlaceholderOrEmptyKey(envKey) && (!this.geminiClient || this.geminiInitKey !== envKey!.trim())) {
        // Initialize client dynamically if key was configured after constructor, unless a test injected a custom SDK client
        if (!this.geminiClient) {
          this.geminiClient = new GoogleGenAI({ apiKey: envKey!.trim() });
          this.geminiInitKey = envKey!.trim();
        }
      }
      if (!this.geminiClient || isPlaceholderOrEmptyKey(envKey)) {
        throw new Error(
          `[AEL LLM] Missing or invalid Gemini API key for provider '${this.profile.name}' (env '${this.profile.api_key_env}'). Live provider credentials are required.`
        );
      }
      return await this.callGemini(prompt, model, options, start);
    }

    throw new Error(
      `[AEL LLM] Unsupported provider type '${String((this.profile as any).type)}'. Only live providers ('openai', 'anthropic', 'gemini') are permitted.`
    );
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

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      throw new Error(`[AEL LLM] Invalid OpenAI response: malformed JSON (${err?.message || String(err)})`);
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error('[AEL LLM] Invalid OpenAI response: missing choices array');
    }

    const text = data.choices[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('[AEL LLM] Invalid OpenAI response: missing or empty message.content');
    }

    const usage = data.usage;
    if (!usage || typeof usage !== 'object') {
      throw new Error('[AEL LLM] Invalid OpenAI response: missing usage metadata. Refusing to estimate tokens.');
    }

    const input_tokens = assertNonNegativeFiniteTokenCount(usage.prompt_tokens, 'usage.prompt_tokens', 'OpenAI');
    const output_tokens = assertNonNegativeFiniteTokenCount(usage.completion_tokens, 'usage.completion_tokens', 'OpenAI');

    let reasoning_tokens = 0;
    const rawReasoning = usage.completion_tokens_details?.reasoning_tokens;
    if (rawReasoning !== undefined) {
      reasoning_tokens = assertNonNegativeFiniteTokenCount(
        rawReasoning,
        'usage.completion_tokens_details.reasoning_tokens',
        'OpenAI'
      );
    } else if (typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens) && usage.total_tokens > input_tokens + output_tokens) {
      reasoning_tokens = usage.total_tokens - (input_tokens + output_tokens);
    }

    const total_tokens =
      typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
        ? Math.max(usage.total_tokens, input_tokens + output_tokens + reasoning_tokens)
        : input_tokens + output_tokens + reasoning_tokens;

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
      model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : model,
      ...(logprob_confidence !== undefined ? { logprob_confidence } : {}),
      confidence_source,
      provider_source: 'openai',
      usage_source: 'provider_reported',
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

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      throw new Error(`[AEL LLM] Invalid Anthropic response: malformed JSON (${err?.message || String(err)})`);
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.content) || data.content.length === 0) {
      throw new Error('[AEL LLM] Invalid Anthropic response: missing content blocks');
    }

    const textParts = data.content
      .filter((b: any) => b && typeof b === 'object' && typeof b.text === 'string' && (b.type === undefined || b.type === 'text'))
      .map((b: any) => b.text);
    const text = textParts.join('');
    if (text.length === 0) {
      throw new Error('[AEL LLM] Invalid Anthropic response: missing or empty text content');
    }

    const usage = data.usage;
    if (!usage || typeof usage !== 'object') {
      throw new Error('[AEL LLM] Invalid Anthropic response: missing usage metadata. Refusing to estimate tokens.');
    }

    const input_tokens = assertNonNegativeFiniteTokenCount(usage.input_tokens, 'usage.input_tokens', 'Anthropic');
    const output_tokens = assertNonNegativeFiniteTokenCount(usage.output_tokens, 'usage.output_tokens', 'Anthropic');

    let reasoning_tokens = 0;
    if (usage.thinking_tokens !== undefined) {
      reasoning_tokens = assertNonNegativeFiniteTokenCount(usage.thinking_tokens, 'usage.thinking_tokens', 'Anthropic');
    } else if (usage.reasoning_tokens !== undefined) {
      reasoning_tokens = assertNonNegativeFiniteTokenCount(usage.reasoning_tokens, 'usage.reasoning_tokens', 'Anthropic');
    }

    const total_tokens = input_tokens + output_tokens + reasoning_tokens;
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
      model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : model,
      confidence_source: 'unavailable',
      provider_source: 'anthropic',
      usage_source: 'provider_reported',
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

    if (!response || typeof response !== 'object') {
      throw new Error('[AEL LLM] Invalid Gemini response: empty or non-object payload');
    }

    if (Array.isArray(response.candidates) && response.candidates.length === 0) {
      throw new Error('[AEL LLM] Invalid Gemini response: zero candidates returned');
    }

    const candidateText =
      typeof response.text === 'string'
        ? response.text
        : Array.isArray(response.candidates?.[0]?.content?.parts)
          ? response.candidates[0].content.parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
          : '';

    if (typeof candidateText !== 'string' || candidateText.length === 0) {
      throw new Error('[AEL LLM] Invalid Gemini response: missing or empty text output');
    }

    const usage = (response as any).usageMetadata;
    if (!usage || typeof usage !== 'object') {
      throw new Error('[AEL LLM] Invalid Gemini response: missing usageMetadata. Refusing to estimate tokens.');
    }

    const input_tokens = assertNonNegativeFiniteTokenCount(
      usage.promptTokenCount,
      'usageMetadata.promptTokenCount',
      'Gemini'
    );
    const output_tokens = assertNonNegativeFiniteTokenCount(
      usage.candidatesTokenCount,
      'usageMetadata.candidatesTokenCount',
      'Gemini'
    );

    let reasoning_tokens = 0;
    if (usage.thoughtsTokenCount !== undefined) {
      reasoning_tokens = assertNonNegativeFiniteTokenCount(
        usage.thoughtsTokenCount,
        'usageMetadata.thoughtsTokenCount',
        'Gemini'
      );
    } else if (usage.reasoningTokenCount !== undefined) {
      reasoning_tokens = assertNonNegativeFiniteTokenCount(
        usage.reasoningTokenCount,
        'usageMetadata.reasoningTokenCount',
        'Gemini'
      );
    } else if (
      typeof usage.totalTokenCount === 'number' &&
      Number.isFinite(usage.totalTokenCount) &&
      usage.totalTokenCount > input_tokens + output_tokens
    ) {
      reasoning_tokens = usage.totalTokenCount - (input_tokens + output_tokens);
    }

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
      text: candidateText,
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
      usage_source: 'provider_reported',
    };
  }

  public calculateCost(inputTokens: number, outputTokens: number, reasoningTokens: number = 0): number {
    const inputCost = (inputTokens / 1_000_000) * this.profile.input_cost_per_million;
    const outputCost = (outputTokens / 1_000_000) * this.profile.output_cost_per_million;
    const reasoningCost = (reasoningTokens / 1_000_000) * this.profile.reasoning_cost_per_million;
    return Number((inputCost + outputCost + reasoningCost).toFixed(6));
  }
}
