/**
 * AEL Mock MCP Server — Filesystem
 * @license Apache-2.0
 */

import { ToolRecord } from '../../src/models/contracts.js';

export const FILESYSTEM_TOOLS: ToolRecord[] = [
  {
    name: 'fs_read_file',
    description: 'Read the contents of a file at the specified virtual path.',
    server: 'filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read' },
      },
      required: ['path'],
    },
    dry_run_support: 'real',
    side_effect: 'none',
    reversible: true,
    requires_human_approval: false,
  },
  {
    name: 'fs_list_directory',
    description: 'List all files and folders in the target directory.',
    server: 'filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
      },
      required: ['path'],
    },
    dry_run_support: 'real',
    side_effect: 'none',
    reversible: true,
    requires_human_approval: false,
  },
  {
    name: 'fs_write_file',
    description: 'Write content to a file, overwriting any existing content.',
    server: 'filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Text content to write' },
      },
      required: ['path', 'content'],
    },
    dry_run_support: 'none',
    side_effect: 'mutating',
    reversible: true,
    reversal_tool_ref: 'fs_delete_file',
    requires_human_approval: false,
  },
  {
    name: 'fs_delete_file',
    description: 'Permanently remove a file from disk.',
    server: 'filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete' },
      },
      required: ['path'],
    },
    dry_run_support: 'none',
    side_effect: 'mutating',
    reversible: false,
    requires_human_approval: true,
  },
];

export class MockFilesystemServer {
  private files: Map<string, string> = new Map([
    ['/workspace/src/index.ts', 'console.log("Hello AEL");'],
    ['/workspace/README.md', '# Agent Economics Layer\nDocumentation'],
    ['/workspace/config.json', '{"preset": "balanced", "retries": 3}'],
  ]);

  public execute(name: string, args: Record<string, any>, isDryRun: boolean): any {
    switch (name) {
      case 'fs_read_file': {
        const p = args.path;
        if (!this.files.has(p)) {
          throw new Error(`FileNotFoundError: No file found at path '${p}'`);
        }
        return { content: this.files.get(p), path: p, dry_run: isDryRun };
      }
      case 'fs_list_directory': {
        const p = args.path || '/workspace';
        const matched = Array.from(this.files.keys()).filter(k => k.startsWith(p));
        return { files: matched, directory: p, count: matched.length, dry_run: isDryRun };
      }
      case 'fs_write_file': {
        if (isDryRun) {
          throw new Error(`DryRunViolation: Cannot execute mutating tool 'fs_write_file' during dry-run.`);
        }
        this.files.set(args.path, args.content);
        return { success: true, path: args.path, bytes: args.content.length };
      }
      case 'fs_delete_file': {
        if (isDryRun) {
          throw new Error(`DryRunViolation: Cannot execute destructive tool 'fs_delete_file' during dry-run.`);
        }
        const existed = this.files.delete(args.path);
        return { success: true, deleted: existed, path: args.path };
      }
      default:
        throw new Error(`Unknown filesystem tool: '${name}'`);
    }
  }
}
