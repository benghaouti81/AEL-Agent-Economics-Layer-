/**
 * Unit Tests: Data Contracts, Execution Contracts & ToolRegistry
 * @license Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ToolRecordSchema, DecisionRecordSchema } from '../src/models/contracts.js';
import { ToolRegistry } from '../src/mcp/registry.js';

describe('Contracts & Schemas', () => {
  it('validates a correct ToolRecord with author execution contract', () => {
    const validTool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      server: 'test_server',
      dry_run_support: 'real',
      side_effect: 'none',
      reversible: true,
      requires_human_approval: false,
    };

    const parsed = ToolRecordSchema.parse(validTool);
    expect(parsed.name).toBe('test_tool');
    expect(parsed.dry_run_support).toBe('real');
  });

  it('rejects invalid dry_run_support or missing author contracts', () => {
    const invalidTool = {
      name: 'bad_tool',
      description: 'No contracts',
      parameters: {},
      dry_run_support: 'invalid_mode',
      side_effect: 'none',
    };

    expect(() => ToolRecordSchema.parse(invalidTool)).toThrow();
  });

  it('computes dynamic schema_hash and updates when toolset changes', () => {
    const registry = new ToolRegistry();
    const hash1 = registry.getSchemaHash();

    registry.registerTool({
      name: 'tool_a',
      description: 'Tool A',
      parameters: {},
      server: 'test',
      dry_run_support: 'real',
      side_effect: 'none',
      reversible: false,
      requires_human_approval: false,
    });

    const hash2 = registry.getSchemaHash();
    expect(hash2).not.toBe(hash1);

    registry.registerTool({
      name: 'tool_b',
      description: 'Tool B',
      parameters: {},
      server: 'test',
      dry_run_support: 'none',
      side_effect: 'mutating',
      reversible: false,
      requires_human_approval: true,
    });

    const hash3 = registry.getSchemaHash();
    expect(hash3).not.toBe(hash2);
  });

  it('validates arguments correctly against tool JSON schema', () => {
    const registry = new ToolRegistry([
      {
        name: 'test_calc',
        description: 'Calculator',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
            op: { type: 'string', enum: ['add', 'subtract'] },
          },
          required: ['a', 'b', 'op'],
        },
        server: 'calc',
        dry_run_support: 'real',
        side_effect: 'none',
        reversible: true,
        requires_human_approval: false,
      },
    ]);

    const validCheck = registry.validateArguments('test_calc', { a: 10, b: 5, op: 'add' });
    expect(validCheck.valid).toBe(true);
    expect(validCheck.errors).toHaveLength(0);

    const invalidCheck = registry.validateArguments('test_calc', { a: 'not_a_num', b: 5, op: 'multiply' });
    expect(invalidCheck.valid).toBe(false);
    expect(invalidCheck.errors.length).toBeGreaterThan(0);
  });
});
