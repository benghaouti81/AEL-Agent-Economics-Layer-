/**
 * AEL — Agent Economics Layer
 * Provider-Agnostic LLM Adapter Layer
 * Supports OpenAI-compatible, Anthropic-style, Gemini, and Local Mock
 * Tracks input, output, reasoning tokens, and USD costs
 * Enforces graceful degradation when provider lacks reasoning knobs
 * @license Apache-2.0
 */

import { ProviderProfile } from '../config/ael_config.js';
import { GoogleGenAI } from '@google/genai';

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
  provider_source: 'openai' | 'anthropic' | 'gemini' | 'mock_simulator';
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

    return {
      text,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_usd,
      latency_ms,
      model,
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
      provider_source: 'anthropic',
    };
  }

  private async callGemini(
    prompt: string,
    model: string,
    options: LLMRequestOptions,
    startTime: number
  ): Promise<LLMResponse> {
    const config: any = {};
    if (options.temperature !== undefined) config.temperature = options.temperature;
    if (options.max_tokens !== undefined) config.maxOutputTokens = options.max_tokens;
    if (options.system_instruction) config.systemInstruction = options.system_instruction;

    const response = await this.geminiClient!.models.generateContent({
      model,
      contents: prompt,
      config,
    });

    const text = response.text || '';
    const usage = (response as any).usageMetadata || {};
    const input_tokens = usage.promptTokenCount || Math.ceil(prompt.length / 4);
    const output_tokens = usage.candidatesTokenCount || Math.ceil(text.length / 4);
    const reasoning_tokens = usage.reasoningTokenCount || 0;
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
      model,
      logprob_confidence: 0.88,
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
      logprob_confidence: 0.85,
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
