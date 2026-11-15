/**
 * Isolated Unit-Test LLM Double (STRICTLY TEST-ONLY)
 *
 * Used ONLY by unit tests to test BudgetEngine, ToolDCEngine, CircuitBreaker, and McpGateway
 * behavior in isolation from network/live LLM APIs.
 * - Always emits provider_source: 'unit_test' and usage_source: 'unit_test'.
 * - Rejected by runBudgetEvalSuite(), runToolEvalSuite(), and validateBenchmarkResult().
 * - Never writes benchmark reports or generates accepted performance evidence.
 *
 * @license Apache-2.0
 */

import { ProviderProfile } from '../../src/config/ael_config.js';
import { LLMClient, LLMRequestOptions, LLMResponse } from '../../src/llm/client.js';

export function createUnitTestProviderProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: 'unit_test_profile',
    type: 'gemini',
    api_key_env: 'UNIT_TEST_UNUSED_KEY',
    default_model: 'unit-test-double',
    cheap_model: 'unit-test-double',
    reasoning_model: 'unit-test-double',
    supports_reasoning_effort: true,
    supports_logprobs: false,
    input_cost_per_million: 0.1,
    output_cost_per_million: 0.4,
    reasoning_cost_per_million: 0.4,
    ...overrides,
  };
}

export class UnitTestLLMDouble extends LLMClient {
  constructor(
    profile: ProviderProfile = createUnitTestProviderProfile(),
    private customResponder?: (prompt: string, options: LLMRequestOptions) => Partial<LLMResponse> | void
  ) {
    super(profile);
  }

  public override async complete(prompt: string, options: LLMRequestOptions = {}): Promise<LLMResponse> {
    const profile = this.getProfile();
    const model = options.model || profile.default_model;

    if (this.customResponder) {
      const custom = this.customResponder(prompt, options);
      if (custom && typeof custom.text === 'string') {
        const input_tokens = custom.input_tokens ?? 25;
        const output_tokens = custom.output_tokens ?? 12;
        const reasoning_tokens = custom.reasoning_tokens ?? 0;
        const total_tokens = custom.total_tokens ?? input_tokens + output_tokens + reasoning_tokens;
        return {
          text: custom.text,
          input_tokens,
          output_tokens,
          reasoning_tokens,
          total_tokens,
          cost_usd: custom.cost_usd ?? this.calculateCost(input_tokens, output_tokens, reasoning_tokens),
          latency_ms: custom.latency_ms ?? 5,
          model: custom.model ?? model,
          ...(custom.logprob_confidence !== undefined ? { logprob_confidence: custom.logprob_confidence } : {}),
          confidence_source: custom.confidence_source ?? 'unavailable',
          provider_source: 'unit_test',
          usage_source: 'unit_test',
        };
      }
    }

    const input_tokens = Math.max(10, Math.ceil(prompt.length / 4));
    const reasoning_tokens =
      options.reasoning_effort === 'high'
        ? 600
        : options.reasoning_effort === 'medium'
          ? 250
          : options.reasoning_effort === 'low'
            ? 80
            : 0;

    let text = 'Unit-test double output.';
    if (prompt.includes('SELECT TOOL AND ARGUMENTS')) {
      const taskMatch = prompt.match(/for this user task:\s*\n?"([^"]+)"|SELECT TOOL AND ARGUMENTS:\s*"([^"]+)"/);
      const lower = (taskMatch ? (taskMatch[1] || taskMatch[2] || '') : prompt.split('\n').slice(0, 3).join(' ')).toLowerCase();
      if (lower.includes('sql') || lower.includes('select') || lower.includes('warehouse')) {
        text = JSON.stringify({
          tool: 'db_query_readonly',
          arguments: { sql: 'SELECT * FROM metrics' },
          reasoning: 'unit test tool match',
        });
      } else if (lower.includes('transfer') || lower.includes('funds') || lower.includes('money')) {
        text = JSON.stringify({
          tool: 'fin_transfer_funds',
          arguments: { source_account: 'acc_001', target_account: 'acc_002', amount_usd: 50 },
          reasoning: 'unit test transfer match',
        });
      } else if (lower.includes('search') || lower.includes('pricing')) {
        text = JSON.stringify({
          tool: 'search_knowledge_base',
          arguments: { query: 'economics layer' },
          reasoning: 'unit test search match',
        });
      } else if (lower.includes('list') || lower.includes('directory')) {
        text = JSON.stringify({
          tool: 'fs_list_directory',
          arguments: { path: '/workspace' },
          reasoning: 'unit test list match',
        });
      } else {
        text = JSON.stringify({
          tool: 'fs_read_file',
          arguments: { path: '/workspace/README.md' },
          reasoning: 'unit test file read match',
        });
      }
    } else if (prompt.includes('EVALUATE EVIDENCE')) {
      text = JSON.stringify({
        resolved: true,
        answer: 'Unit-test judge step completed',
      });
    }

    const output_tokens = Math.max(5, Math.ceil(text.length / 4));
    const total_tokens = input_tokens + output_tokens + reasoning_tokens;

    return {
      text,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_usd: this.calculateCost(input_tokens, output_tokens, reasoning_tokens),
      latency_ms: 5,
      model,
      confidence_source: 'unavailable',
      provider_source: 'unit_test',
      usage_source: 'unit_test',
    };
  }
}

export function createUnitTestLLMClient(
  overrides: Partial<ProviderProfile> = {},
  customResponder?: (prompt: string, options: LLMRequestOptions) => Partial<LLMResponse> | void
): LLMClient {
  return new UnitTestLLMDouble(createUnitTestProviderProfile(overrides), customResponder);
}
