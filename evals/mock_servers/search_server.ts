/**
 * AEL Mock MCP Server — Search & Database
 * @license Apache-2.0
 */

import { ToolRecord } from '../../src/models/contracts.js';

export const SEARCH_TOOLS: ToolRecord[] = [
  {
    name: 'search_knowledge_base',
    description: 'Query internal knowledge base articles by semantic query.',
    server: 'search',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or question' },
        limit: { type: 'number', description: 'Maximum results to return' },
      },
      required: ['query'],
    },
    dry_run_support: 'real',
    side_effect: 'none',
    reversible: true,
    requires_human_approval: false,
  },
  {
    name: 'db_query_readonly',
    description: 'Execute a read-only SQL SELECT statement against the reporting warehouse.',
    server: 'search',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL SELECT query' },
      },
      required: ['sql'],
    },
    dry_run_support: 'real',
    side_effect: 'idempotent',
    reversible: true,
    requires_human_approval: false,
  },
];

export class MockSearchServer {
  private docs = [
    { id: '1', title: 'AEL Overview', content: 'Agent Economics Layer cuts token costs by 50%+' },
    { id: '2', title: 'Tool-DC Guide', content: 'Divide, Try, Check, Retry finite state machine' },
    { id: '3', title: 'Pricing Policy', content: 'Enterprise pricing is $0.002 per token baseline' },
  ];

  public execute(name: string, args: Record<string, any>, isDryRun: boolean): any {
    switch (name) {
      case 'search_knowledge_base': {
        const q = (args.query || '').toLowerCase();
        if (!q.trim()) {
          throw new Error('QueryError: Search query cannot be empty string');
        }
        const matches = this.docs.filter(d => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));
        return { results: matches, count: matches.length, dry_run: isDryRun };
      }
      case 'db_query_readonly': {
        const sql = (args.sql || '').trim();
        if (!sql.toUpperCase().startsWith('SELECT')) {
          throw new Error(`SecurityException: Only SELECT queries permitted. Got '${sql.split(' ')[0]}'`);
        }
        return {
          rows: [{ id: 101, status: 'completed', cost: 0.012 }],
          row_count: 1,
          dry_run: isDryRun,
        };
      }
      default:
        throw new Error(`Unknown search tool: '${name}'`);
    }
  }
}
