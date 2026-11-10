/**
 * AEL — Agent Economics Layer
 * Tool Registry & Semantic Batch Indexer
 * Manages Author-Declared Execution Contracts & schema_hash
 * @license Apache-2.0
 */

import crypto from 'node:crypto';
import { ToolRecord, ToolRecordInput, ToolRecordSchema } from '../models/contracts.js';

export class ToolRegistry {
  private tools: Map<string, ToolRecord> = new Map();
  private _cachedSchemaHash: string | null = null;

  constructor(initialTools: ToolRecordInput[] = []) {
    for (const tool of initialTools) {
      this.registerTool(tool);
    }
  }

  public registerTool(tool: ToolRecordInput): void {
    const validated = ToolRecordSchema.parse(tool);
    this.tools.set(validated.name, validated);
    this._cachedSchemaHash = null; // Invalidate schema hash
  }

  public unregisterTool(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      this._cachedSchemaHash = null;
    }
    return deleted;
  }

  public getTool(name: string): ToolRecord | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): ToolRecord[] {
    return Array.from(this.tools.values());
  }

  /**
   * Cryptographic SHA-256 hash of all tool names, descriptions, and parameter schemas.
   * Any change in the toolset instantly updates this hash, invalidating cached plans.
   */
  public getSchemaHash(): string {
    if (this._cachedSchemaHash) {
      return this._cachedSchemaHash;
    }

    const sortedTools = this.getAllTools()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(t => ({
        name: t.name,
        desc: t.description,
        params: t.parameters,
        dry_run: t.dry_run_support,
        side_effect: t.side_effect,
        approval: t.requires_human_approval,
      }));

    this._cachedSchemaHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(sortedTools))
      .digest('hex')
      .substring(0, 16);

    return this._cachedSchemaHash;
  }

  /**
   * Semantic candidate batch retriever (Divide phase of Tool-DC)
   * Instead of dumping hundreds of tools into the LLM prompt,
   * score candidates by token overlap / semantic keywords and return a focused batch of top-K tools.
   */
  public retrieveCandidates(query: string, batchSize: number = 4): ToolRecord[] {
    const queryTokens = new Set(
      query.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(t => t.length > 2)
    );

    const scored = this.getAllTools().map(tool => {
      let score = 0;
      const toolText = `${tool.name} ${tool.description} ${Object.keys(tool.parameters?.properties || {}).join(' ')}`.toLowerCase();
      const toolTokens = toolText.split(/\s+/);

      for (const token of queryTokens) {
        if (tool.name.toLowerCase().includes(token)) {
          score += 5;
        } else if (toolTokens.some(tt => tt.includes(token))) {
          score += 2;
        }
      }

      return { tool, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, batchSize)).map(s => s.tool);
  }

  /**
   * Validates arguments against the tool's JSON schema properties and required fields.
   */
  public validateArguments(toolName: string, args: Record<string, any>): { valid: boolean; errors: string[] } {
    const tool = this.getTool(toolName);
    if (!tool) {
      return { valid: false, errors: [`Tool '${toolName}' not found in registry`] };
    }

    const errors: string[] = [];
    const schema = tool.parameters || {};
    const properties = schema.properties || {};
    const required = schema.required || [];

    // Check required fields
    for (const req of required) {
      if (args[req] === undefined || args[req] === null || args[req] === '') {
        errors.push(`Missing required parameter: '${req}'`);
      }
    }

    // Check type constraints for provided arguments
    for (const [key, val] of Object.entries(args)) {
      const propDef = properties[key];
      if (propDef) {
        if (propDef.type === 'string' && typeof val !== 'string') {
          errors.push(`Parameter '${key}' must be a string, got ${typeof val}`);
        } else if (propDef.type === 'number' && typeof val !== 'number') {
          errors.push(`Parameter '${key}' must be a number, got ${typeof val}`);
        } else if (propDef.type === 'integer' && (!Number.isInteger(val))) {
          errors.push(`Parameter '${key}' must be an integer, got ${typeof val}`);
        } else if (propDef.type === 'boolean' && typeof val !== 'boolean') {
          errors.push(`Parameter '${key}' must be a boolean, got ${typeof val}`);
        } else if (propDef.type === 'array' && !Array.isArray(val)) {
          errors.push(`Parameter '${key}' must be an array, got ${typeof val}`);
        } else if (propDef.enum && !propDef.enum.includes(val)) {
          errors.push(`Parameter '${key}' value '${val}' is not in allowed enum: [${propDef.enum.join(', ')}]`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
