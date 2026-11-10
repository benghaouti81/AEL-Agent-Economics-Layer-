/**
 * AEL — Agent Economics Layer
 * MCP Gateway & Meta-Tools Surface
 * Exposes: discover_tools, get_tool_schema, execute_tool, smart_action
 * @license Apache-2.0
 */

import { ToolRegistry } from './registry.js';
import { DryRunSandbox } from './sandbox.js';
import { ToolDCEngine } from '../engines/tool_dc.js';
import { DecisionLogStore } from '../db/decision_log.js';
import { ProviderProfile } from '../config/ael_config.js';

export class McpGateway {
  constructor(
    private registry: ToolRegistry,
    private sandbox: DryRunSandbox,
    private toolDcEngine: ToolDCEngine,
    private logStore: DecisionLogStore,
    private provider: ProviderProfile
  ) {}

  /**
   * Meta-Tool 1: discover_tools
   * Returns lightweight summary catalog (name, description, server, side_effect)
   * avoiding context bloat from full parameter schemas.
   */
  public discoverTools(query?: string): any[] {
    const tools = query ? this.registry.retrieveCandidates(query, 10) : this.registry.getAllTools();
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      server: t.server,
      side_effect: t.side_effect,
      dry_run_support: t.dry_run_support,
      requires_human_approval: t.requires_human_approval,
    }));
  }

  /**
   * Meta-Tool 2: get_tool_schema
   * Returns complete JSON schema and execution contract for a specific tool.
   */
  public getToolSchema(toolName: string): any {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      throw new Error(`ToolNotFound: '${toolName}'`);
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      contract: {
        dry_run_support: tool.dry_run_support,
        side_effect: tool.side_effect,
        reversible: tool.reversible,
        reversal_tool_ref: tool.reversal_tool_ref,
        requires_human_approval: tool.requires_human_approval,
        idempotency_key: tool.idempotency_key,
      },
    };
  }

  /**
   * Meta-Tool 3: execute_tool
   * Executes a tool with explicit safety contract and human approval check.
   */
  public async executeTool(
    toolName: string,
    args: Record<string, any>,
    humanApprovalGranted: boolean = false
  ): Promise<any> {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      throw new Error(`ToolNotFound: '${toolName}'`);
    }

    const validation = this.registry.validateArguments(toolName, args);
    if (!validation.valid) {
      throw new Error(`ArgumentValidationError: ${validation.errors.join('; ')}`);
    }

    return await this.sandbox.executeLive(tool, args, humanApprovalGranted);
  }

  /**
   * Meta-Tool 4: smart_action
   * Primary entry point for AI agents. Employs the Tool-DC Try-Check-Retry FSM:
   * 1. Divides candidate tool pool into focused batch
   * 2. Proposes tool and arguments
   * 3. Checks JSON schema and safe dry-runs
   * 4. Retries with reflection on error
   * 5. Logs to Decision Log
   */
  public async smartAction(
    taskQuery: string,
    options: {
      workflow_id?: string;
      human_approval_granted?: boolean;
      pass_through?: boolean;
    } = {}
  ): Promise<any> {
    return await this.toolDcEngine.selectAndExecute(taskQuery, {
      workflow_id: options.workflow_id || 'default_workflow',
      human_approval_granted: options.human_approval_granted || false,
      pass_through: options.pass_through || false,
    });
  }
}
