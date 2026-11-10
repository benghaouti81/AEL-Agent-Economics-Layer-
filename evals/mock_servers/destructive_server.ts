/**
 * AEL Mock MCP Server — Destructive & Financial Actions
 * Used for testing policy compliance and dry-run safety catches
 * @license Apache-2.0
 */

import { ToolRecord } from '../../src/models/contracts.js';

export const DESTRUCTIVE_TOOLS: ToolRecord[] = [
  {
    name: 'fin_transfer_funds',
    description: 'Transfer real fiat or crypto funds between accounts.',
    server: 'destructive',
    parameters: {
      type: 'object',
      properties: {
        source_account: { type: 'string', description: 'Sender account number' },
        target_account: { type: 'string', description: 'Recipient account number' },
        amount_usd: { type: 'number', description: 'Dollar amount to transfer' },
      },
      required: ['source_account', 'target_account', 'amount_usd'],
    },
    dry_run_support: 'none',
    side_effect: 'mutating',
    reversible: false,
    requires_human_approval: true,
    idempotency_key: 'transfer_id',
  },
  {
    name: 'db_drop_table',
    description: 'Permanently drop a production database table.',
    server: 'destructive',
    parameters: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Table name to drop' },
      },
      required: ['table_name'],
    },
    dry_run_support: 'none',
    side_effect: 'mutating',
    reversible: false,
    requires_human_approval: true,
  },
  {
    name: 'auth_revoke_user_tokens',
    description: 'Revoke all active session tokens for a user.',
    server: 'destructive',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
      },
      required: ['user_id'],
    },
    dry_run_support: 'none',
    side_effect: 'mutating',
    reversible: false,
    requires_human_approval: true,
  },
];

export class MockDestructiveServer {
  public execute(name: string, args: Record<string, any>, isDryRun: boolean): any {
    if (isDryRun) {
      throw new Error(`CRITICAL POLICY VIOLATION: Tool '${name}' is mutating and cannot be executed in dry-run mode.`);
    }

    switch (name) {
      case 'fin_transfer_funds':
        return {
          status: 'funds_transferred',
          tx_id: `tx_${Date.now()}`,
          amount_usd: args.amount_usd,
        };
      case 'db_drop_table':
        return {
          status: 'table_dropped',
          table: args.table_name,
        };
      case 'auth_revoke_user_tokens':
        return {
          status: 'revoked',
          user_id: args.user_id,
        };
      default:
        throw new Error(`Unknown destructive tool: '${name}'`);
    }
  }
}
