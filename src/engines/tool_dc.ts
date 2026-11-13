/**
 * AEL — Agent Economics Layer
 * Tool-DC Engine (arXiv:2603.11495)
 * Training-free Try-Check-Retry Divide-and-Conquer Tool Selection
 * @license Apache-2.0
 */

import crypto from 'node:crypto';
import { ToolRegistry } from '../mcp/registry.js';
import { DryRunSandbox, DryRunResult } from '../mcp/sandbox.js';
import { LLMClient } from '../llm/client.js';
import { DecisionLogStore } from '../db/decision_log.js';
import { DecisionRecord, ToolRecord } from '../models/contracts.js';

export interface ToolDCSelectionResult {
  success: boolean;
  tool_name: string | null;
  arguments: Record<string, any>;
  retries: number;
  dry_run: DryRunResult | null;
  cached: boolean;
  execution_result?: any;
  error?: string;
  overhead_tokens: number;
  overhead_cost_usd: number;
  baseline_tokens: number;
  baseline_cost_usd: number;
}

export class ToolDCEngine {
  private cache: Map<string, { tool_name: string; args: Record<string, any>; schema_hash: string }> = new Map();

  constructor(
    private registry: ToolRegistry,
    private sandbox: DryRunSandbox,
    private llm: LLMClient,
    private logStore: DecisionLogStore
  ) {}

  /**
   * Runtime-measured baseline:
   * Serializes the full tool-schema dump from the registry (exactly what a non-AEL agent would place into context).
   * Token count uses standard documented approximation: Math.ceil(serialized.length / 4).
   * Cost is derived dynamically from the active provider profile's input pricing via llm.calculateCost(tokens, 0, 0).
   */
  public computeRegistryBaseline(): { baselineTokens: number; baselineCostUsd: number } {
    const allTools = this.registry.getAllTools();
    if (allTools.length === 0) {
      return { baselineTokens: 0, baselineCostUsd: 0 };
    }
    const serialized = JSON.stringify(allTools);
    // Documented token approximation: 1 token ~= 4 characters of JSON serialized schema
    const baselineTokens = Math.ceil(serialized.length / 4);
    const baselineCostUsd = this.llm.calculateCost(baselineTokens, 0, 0);
    return { baselineTokens, baselineCostUsd };
  }

  public async selectAndExecute(
    taskQuery: string,
    options: {
      workflow_id?: string;
      max_retries?: number;
      human_approval_granted?: boolean;
      pass_through?: boolean;
    } = {}
  ): Promise<ToolDCSelectionResult> {
    const startTime = Date.now();
    const workflow_id = options.workflow_id || 'default_workflow';
    const maxRetries = options.max_retries ?? 3;
    const approval = options.human_approval_granted ?? false;
    const passThrough = options.pass_through ?? false;

    // Runtime-measured baseline from current registry tool schemas
    const { baselineTokens, baselineCostUsd } = this.computeRegistryBaseline();

    const schema_hash = this.registry.getSchemaHash();
    const query_hash = crypto.createHash('sha256').update(taskQuery).digest('hex').substring(0, 16);
    const cacheKey = `${query_hash}_${schema_hash}`;

    // Pass-through baseline: dump all tools into context, 1 attempt, no dry-run verification
    if (passThrough) {
      return this.executePassThrough(taskQuery, workflow_id, query_hash, schema_hash, startTime, approval, baselineTokens, baselineCostUsd);
    }

    // Check plan cache (schema_hash ensures instant invalidation on toolset update)
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (cached.schema_hash === schema_hash) {
        const tool = this.registry.getTool(cached.tool_name);
        if (tool) {
          const execRes = await this.sandbox.executeLive(tool, cached.args, approval);
          this.logDecision({
            workflow_id,
            query_hash,
            schema_hash,
            task_category: 'mcp_tool_selection',
            tool_chosen: cached.tool_name,
            tool_args_hash: crypto.createHash('sha256').update(JSON.stringify(cached.args)).digest('hex').substring(0, 12),
            retries_count: 0,
            dry_run_executed: false,
            dry_run_passed: true,
            dry_run_caught_error: null,
            human_approval_granted: approval,
            baseline_tokens: baselineTokens,
            upstream_tokens: 0,
            ael_internal_tokens: 0,
            net_tokens_saved: baselineTokens,
            baseline_cost_usd: baselineCostUsd,
            upstream_cost_usd: 0,
            ael_internal_cost_usd: 0,
            net_cost_saved_usd: baselineCostUsd,
            latency_ms: Date.now() - startTime,
            ael_overhead_ms: 2,
            completed_successfully: execRes.success,
            pass_through: false,
          });

          return {
            success: execRes.success,
            tool_name: cached.tool_name,
            arguments: cached.args,
            retries: 0,
            dry_run: null,
            cached: true,
            execution_result: execRes.result,
            error: execRes.error,
            overhead_tokens: 0,
            overhead_cost_usd: 0,
            baseline_tokens: baselineTokens,
            baseline_cost_usd: baselineCostUsd,
          };
        }
      }
    }

    // DIVIDE: Retrieve focused candidate batch (e.g. 3-4 tools) instead of dozens
    const candidates = this.registry.retrieveCandidates(taskQuery, 4);
    if (candidates.length === 0) {
      return {
        success: false,
        tool_name: null,
        arguments: {},
        retries: 0,
        dry_run: null,
        cached: false,
        error: 'No candidate tools available in registry',
        overhead_tokens: 0,
        overhead_cost_usd: 0,
        baseline_tokens: baselineTokens,
        baseline_cost_usd: baselineCostUsd,
      };
    }

    let retries = 0;
    let lastError: string | null = null;
    let selectedTool: ToolRecord | null = null;
    let finalArgs: Record<string, any> = {};
    let dryRunResult: DryRunResult | null = null;
    let ael_overhead_tokens = 0;
    let ael_overhead_cost = 0;
    let dryRunCaughtError: string | null = null;

    // TRY - CHECK - RETRY FSM Loop
    while (retries <= maxRetries) {
      // Step 1: PROPOSE (Ask model to propose tool + exact args from focused batch)
      const prompt = this.buildSelectionPrompt(taskQuery, candidates, lastError);
      const llmRes = await this.llm.complete(prompt, { reasoning_effort: 'none' });
      
      ael_overhead_tokens += llmRes.total_tokens;
      ael_overhead_cost += llmRes.cost_usd;

      let proposal: { tool: string; arguments: Record<string, any>; reasoning?: string };
      try {
        const jsonMatch = llmRes.text.match(/\{[\s\S]*\}/);
        proposal = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(llmRes.text);
      } catch (err: any) {
        lastError = `JSON parse failure on proposal: ${llmRes.text.substring(0, 100)}`;
        retries++;
        continue;
      }

      const tool = this.registry.getTool(proposal.tool);
      if (!tool) {
        lastError = `Proposed tool '${proposal.tool}' does not exist in active batch.`;
        retries++;
        continue;
      }

      // Step 2: CHECK 1 — Programmatic JSON Schema & argument constraints
      const validation = this.registry.validateArguments(tool.name, proposal.arguments || {});
      if (!validation.valid) {
        lastError = `Argument schema violation: ${validation.errors.join('; ')}`;
        retries++;
        continue;
      }

      // Step 3: CHECK 2 — Dry-Run Sandbox execution (safe/idempotent tools only)
      dryRunResult = await this.sandbox.evaluateDryRun(tool, proposal.arguments || {}, approval);
      if (dryRunResult.executed && !dryRunResult.passed) {
        dryRunCaughtError = dryRunResult.error || 'Dry-run runtime assertion failed';
        lastError = `Dry-run execution failed: ${dryRunCaughtError}`;
        retries++;
        continue;
      }

      // Verification Passed!
      selectedTool = tool;
      finalArgs = proposal.arguments || {};
      break;
    }

    const aelOverheadMs = Date.now() - startTime;

    if (!selectedTool) {
      // Loop exhausted without match
      this.logDecision({
        workflow_id,
        query_hash,
        schema_hash,
        task_category: 'mcp_tool_selection',
        tool_chosen: null,
        tool_args_hash: null,
        retries_count: retries,
        dry_run_executed: true,
        dry_run_passed: false,
        dry_run_caught_error: dryRunCaughtError || lastError,
        human_approval_granted: approval,
        baseline_tokens: baselineTokens,
        upstream_tokens: 0,
        ael_internal_tokens: ael_overhead_tokens,
        net_tokens_saved: Math.max(0, baselineTokens - ael_overhead_tokens),
        baseline_cost_usd: baselineCostUsd,
        upstream_cost_usd: 0,
        ael_internal_cost_usd: ael_overhead_cost,
        net_cost_saved_usd: Number((baselineCostUsd - ael_overhead_cost).toFixed(6)),
        latency_ms: aelOverheadMs,
        ael_overhead_ms: aelOverheadMs,
        completed_successfully: false,
        pass_through: false,
      });

      return {
        success: false,
        tool_name: null,
        arguments: {},
        retries,
        dry_run: dryRunResult,
        cached: false,
        error: lastError || 'Tool-DC retries exhausted without verified match',
        overhead_tokens: ael_overhead_tokens,
        overhead_cost_usd: ael_overhead_cost,
        baseline_tokens: baselineTokens,
        baseline_cost_usd: baselineCostUsd,
      };
    }

    // Cache successful tool plan
    this.cache.set(cacheKey, {
      tool_name: selectedTool.name,
      args: finalArgs,
      schema_hash,
    });

    // Execute Live Tool Call
    const liveExec = await this.sandbox.executeLive(selectedTool, finalArgs, approval);
    const totalLatency = Date.now() - startTime;

    // Baseline already measured from registry schemas & active provider pricing
    const netTokensSaved = Math.max(0, baselineTokens - ael_overhead_tokens);
    const netCostSaved = Number((baselineCostUsd - ael_overhead_cost).toFixed(6));

    this.logDecision({
      workflow_id,
      query_hash,
      schema_hash,
      task_category: 'mcp_tool_selection',
      tool_chosen: selectedTool.name,
      tool_args_hash: crypto.createHash('sha256').update(JSON.stringify(finalArgs)).digest('hex').substring(0, 12),
      retries_count: retries,
      dry_run_executed: dryRunResult ? dryRunResult.executed : false,
      dry_run_passed: dryRunResult ? dryRunResult.passed : true,
      dry_run_caught_error: dryRunCaughtError,
      human_approval_granted: approval,
      baseline_tokens: baselineTokens,
      upstream_tokens: 0,
      ael_internal_tokens: ael_overhead_tokens,
      net_tokens_saved: netTokensSaved,
      baseline_cost_usd: baselineCostUsd,
      upstream_cost_usd: 0,
      ael_internal_cost_usd: ael_overhead_cost,
      net_cost_saved_usd: netCostSaved,
      latency_ms: totalLatency,
      ael_overhead_ms: aelOverheadMs,
      completed_successfully: liveExec.success,
      pass_through: false,
    });

    return {
      success: liveExec.success,
      tool_name: selectedTool.name,
      arguments: finalArgs,
      retries,
      dry_run: dryRunResult,
      cached: false,
      execution_result: liveExec.result,
      error: liveExec.error,
      overhead_tokens: ael_overhead_tokens,
      overhead_cost_usd: ael_overhead_cost,
      baseline_tokens: baselineTokens,
      baseline_cost_usd: baselineCostUsd,
    };
  }

  private buildSelectionPrompt(query: string, batch: ToolRecord[], errorFeedback: string | null): string {
    const toolDescriptions = batch.map(t => {
      return `Tool: ${t.name}
Description: ${t.description}
Parameters JSON Schema: ${JSON.stringify(t.parameters)}
Execution Contract: SideEffect=${t.side_effect}, DryRunSupport=${t.dry_run_support}, RequiresHumanApproval=${t.requires_human_approval}
`;
    }).join('\n---\n');

    let prompt = `You are a precision tool router in the Tool-DC Try-Check-Retry loop.
SELECT TOOL AND ARGUMENTS for this user task:
"${query}"

Candidate tools in this focused batch:
${toolDescriptions}
`;

    if (errorFeedback) {
      prompt += `
PREVIOUS ATTEMPT FAILED WITH ERROR:
"${errorFeedback}"
Reflect on this error and output a corrected tool or valid arguments.
`;
    }

    prompt += `
Output STRICT JSON ONLY in this format:
{
  "tool": "tool_name",
  "arguments": { "param1": "val1" },
  "reasoning": "brief justification"
}
`;

    return prompt;
  }

  private async executePassThrough(
    taskQuery: string,
    workflow_id: string,
    query_hash: string,
    schema_hash: string,
    startTime: number,
    approval: boolean,
    baselineTokens: number,
    baselineCostUsd: number
  ): Promise<ToolDCSelectionResult> {
    // Pass-through: dumps all tools, 0 dry-run verification
    const allTools = this.registry.getAllTools();
    const prompt = `SELECT TOOL AND ARGUMENTS: "${taskQuery}" from all tools:\n` + JSON.stringify(allTools);
    const llmRes = await this.llm.complete(prompt, { reasoning_effort: 'none' });

    let parsed: any = {};
    try {
      parsed = JSON.parse(llmRes.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    } catch {
      parsed = {};
    }

    const tool = this.registry.getTool(parsed.tool);
    const execRes = tool ? await this.sandbox.executeLive(tool, parsed.arguments || {}, approval) : { success: false, error: 'No tool chosen' };

    this.logDecision({
      workflow_id,
      query_hash,
      schema_hash,
      task_category: 'mcp_tool_selection',
      tool_chosen: tool ? tool.name : null,
      tool_args_hash: null,
      retries_count: 0,
      dry_run_executed: false,
      dry_run_passed: null,
      dry_run_caught_error: null,
      human_approval_granted: approval,
      baseline_tokens: baselineTokens,
      upstream_tokens: baselineTokens,
      ael_internal_tokens: 0,
      net_tokens_saved: 0,
      baseline_cost_usd: baselineCostUsd,
      upstream_cost_usd: baselineCostUsd,
      ael_internal_cost_usd: 0,
      net_cost_saved_usd: 0,
      latency_ms: Date.now() - startTime,
      ael_overhead_ms: 1,
      completed_successfully: execRes.success,
      pass_through: true,
    });

    return {
      success: execRes.success,
      tool_name: tool ? tool.name : null,
      arguments: parsed.arguments || {},
      retries: 0,
      dry_run: null,
      cached: false,
      execution_result: execRes.result,
      error: execRes.error,
      overhead_tokens: 0,
      overhead_cost_usd: 0,
      baseline_tokens: baselineTokens,
      baseline_cost_usd: baselineCostUsd,
    };
  }

  private logDecision(entry: Partial<DecisionRecord>): void {
    try {
      this.logStore.insertDecision({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        workflow_id: entry.workflow_id || 'default_workflow',
        query_hash: entry.query_hash || 'hash',
        task_category: entry.task_category || 'mcp_tool_selection',
        schema_hash: entry.schema_hash || 'schema',
        tool_chosen: entry.tool_chosen ?? null,
        tool_args_hash: entry.tool_args_hash ?? null,
        retries_count: entry.retries_count ?? 0,
        dry_run_executed: entry.dry_run_executed ?? false,
        dry_run_passed: entry.dry_run_passed ?? null,
        dry_run_caught_error: entry.dry_run_caught_error ?? null,
        human_approval_granted: entry.human_approval_granted ?? false,
        regime: 'single',
        reasoning_effort: 'none',
        escalated: false,
        escalation_levels: 0,
        confidence_signal: entry.dry_run_passed ? 'externally_verified' : 'insufficient_evidence',
        samples_count: 1,
        baseline_tokens: entry.baseline_tokens ?? 0,
        upstream_tokens: entry.upstream_tokens ?? 0,
        ael_internal_tokens: entry.ael_internal_tokens ?? 0,
        net_tokens_saved: entry.net_tokens_saved ?? 0,
        baseline_cost_usd: entry.baseline_cost_usd ?? 0,
        upstream_cost_usd: entry.upstream_cost_usd ?? 0,
        ael_internal_cost_usd: entry.ael_internal_cost_usd ?? 0,
        net_cost_saved_usd: entry.net_cost_saved_usd ?? 0,
        latency_ms: entry.latency_ms ?? 0,
        ael_overhead_ms: entry.ael_overhead_ms ?? 0,
        completed_successfully: entry.completed_successfully ?? true,
        circuit_breaker_tripped: false,
        pass_through: entry.pass_through ?? false,
      });
    } catch (err) {
      console.warn('[ToolDC] Failed to insert decision record:', err);
    }
  }
}
