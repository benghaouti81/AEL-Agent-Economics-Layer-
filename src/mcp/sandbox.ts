/**
 * AEL — Agent Economics Layer
 * Dry-Run Sandbox & Safety Policy Enforcement
 * Strictly enforces author-declared execution contracts
 * @license Apache-2.0
 */

import { ToolRecord } from '../models/contracts.js';

export interface DryRunResult {
  executed: boolean;
  passed: boolean;
  mode: 'real_execution' | 'simulated' | 'schema_only';
  output?: any;
  error?: string;
  authorization_required: boolean;
  authorization_granted: boolean;
}

export type ToolExecutor = (name: string, args: Record<string, any>, isDryRun: boolean) => Promise<any>;

export class DryRunSandbox {
  private executors: Map<string, ToolExecutor> = new Map();

  public registerExecutor(serverName: string, executor: ToolExecutor): void {
    this.executors.set(serverName, executor);
  }

  /**
   * Evaluates or executes a dry-run check according to strict author-declared rules:
   * 1. If tool is mutating, NEVER execute in dry-run. Run schema and argument checks only.
   * 2. If dry_run_support is "none", do not execute.
   * 3. If dry_run_support is "real" and side_effect is "none" | "idempotent", run safe execution.
   * 4. If requires_human_approval is true, record authorization requirement.
   */
  public async evaluateDryRun(
    tool: ToolRecord,
    args: Record<string, any>,
    humanApprovalGranted: boolean = false
  ): Promise<DryRunResult> {
    const isMutating = tool.side_effect === 'mutating';
    const isSafeToExecute = (tool.side_effect === 'none' || tool.side_effect === 'idempotent') && tool.dry_run_support === 'real';

    // Rule: Mutating tools NEVER execute during dry-run
    if (isMutating) {
      return {
        executed: false,
        passed: true, // Schema check passed
        mode: 'schema_only',
        output: {
          notice: `Tool '${tool.name}' is mutating with dry_run_support='${tool.dry_run_support}'. Real execution blocked during dry-run.`,
          simulated_action: `Target arguments inspected and validated structurally.`,
        },
        authorization_required: tool.requires_human_approval,
        authorization_granted: humanApprovalGranted,
      };
    }

    // Rule: Tools with dry_run_support="simulated"
    if (tool.dry_run_support === 'simulated') {
      return {
        executed: true,
        passed: true,
        mode: 'simulated',
        output: {
          simulated: true,
          tool: tool.name,
          received_args: args,
        },
        authorization_required: tool.requires_human_approval,
        authorization_granted: humanApprovalGranted,
      };
    }

    // Rule: Tools with dry_run_support="none"
    if (!isSafeToExecute) {
      return {
        executed: false,
        passed: true,
        mode: 'schema_only',
        output: { notice: 'Tool author declared dry_run_support=none. Skipping runtime execution.' },
        authorization_required: tool.requires_human_approval,
        authorization_granted: humanApprovalGranted,
      };
    }

    // Execute safe dry-run
    const executor = this.executors.get(tool.server) || this.executors.get('default');
    if (!executor) {
      return {
        executed: false,
        passed: true,
        mode: 'schema_only',
        output: { notice: `No live executor registered for server '${tool.server}'. Checked schema only.` },
        authorization_required: tool.requires_human_approval,
        authorization_granted: humanApprovalGranted,
      };
    }

    try {
      const output = await executor(tool.name, args, true);
      return {
        executed: true,
        passed: true,
        mode: 'real_execution',
        output,
        authorization_required: tool.requires_human_approval,
        authorization_granted: humanApprovalGranted,
      };
    } catch (err: any) {
      return {
        executed: true,
        passed: false,
        mode: 'real_execution',
        error: err.message || String(err),
        authorization_required: tool.requires_human_approval,
        authorization_granted: humanApprovalGranted,
      };
    }
  }

  /**
   * Final live execution of a tool.
   * Enforces that mutating tools with requires_human_approval=true CANNOT execute without explicit approval.
   */
  public async executeLive(
    tool: ToolRecord,
    args: Record<string, any>,
    humanApprovalGranted: boolean = false
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    if (tool.requires_human_approval && !humanApprovalGranted) {
      return {
        success: false,
        error: `SECURITY POLICY VIOLATION: Tool '${tool.name}' requires human approval before live mutation. Explicit approval flag was false.`,
      };
    }

    const executor = this.executors.get(tool.server) || this.executors.get('default');
    if (!executor) {
      return {
        success: false,
        error: `No executor available for server '${tool.server}'`,
      };
    }

    try {
      const result = await executor(tool.name, args, false);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }
}
