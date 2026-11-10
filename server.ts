/**
 * AEL — Agent Economics Layer
 * Full-Stack Server & Middleware Proxy
 * Mounts:
 * - /v1/chat/completions (OpenAI proxy)
 * - /v1/messages (Anthropic proxy)
 * - /mcp/* (MCP Gateway)
 * - /api/metrics/summary & /api/metrics/decisions (Dashboard API)
 * - Vite dev middleware / static dist
 * @license Apache-2.0
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config/ael_config.js';
import { getDecisionLog } from './src/db/decision_log.js';
import { ToolRegistry } from './src/mcp/registry.js';
import { DryRunSandbox } from './src/mcp/sandbox.js';
import { ToolDCEngine } from './src/engines/tool_dc.js';
import { BudgetEngine } from './src/engines/budget.js';
import { CircuitBreakerController } from './src/engines/circuit_breaker.js';
import { LLMClient } from './src/llm/client.js';
import { McpGateway } from './src/mcp/gateway.js';
import { FILESYSTEM_TOOLS, MockFilesystemServer } from './evals/mock_servers/filesystem_server.js';
import { SEARCH_TOOLS, MockSearchServer } from './evals/mock_servers/search_server.js';
import { DESTRUCTIVE_TOOLS, MockDestructiveServer } from './evals/mock_servers/destructive_server.js';
import { runToolEvalSuite } from './evals/suites/tool_eval_suite.js';
import { runBudgetEvalSuite } from './evals/suites/budget_eval_suite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const config = loadConfig(process.env.AEL_CONFIG_PATH || './ael_config.yaml');
  const logStore = getDecisionLog(config.telemetry.db_path);

  // Initialize Tool Registry & Mock Servers
  const registry = new ToolRegistry([
    ...FILESYSTEM_TOOLS,
    ...SEARCH_TOOLS,
    ...DESTRUCTIVE_TOOLS,
  ]);

  const sandbox = new DryRunSandbox();
  const fsServer = new MockFilesystemServer();
  const searchServer = new MockSearchServer();
  const destructiveServer = new MockDestructiveServer();

  sandbox.registerExecutor('filesystem', (name, args, isDryRun) => fsServer.execute(name, args, isDryRun));
  sandbox.registerExecutor('search', (name, args, isDryRun) => searchServer.execute(name, args, isDryRun));
  sandbox.registerExecutor('destructive', (name, args, isDryRun) => destructiveServer.execute(name, args, isDryRun));

  // Initialize Engines
  const llmClient = new LLMClient(config.provider);
  const toolDcEngine = new ToolDCEngine(registry, sandbox, llmClient, logStore);
  const circuitBreaker = new CircuitBreakerController(config.circuit_breaker, logStore);
  const activePreset = config.presets[config.active_preset] || config.presets.balanced;
  const budgetEngine = new BudgetEngine(llmClient, logStore, circuitBreaker, activePreset);
  const mcpGateway = new McpGateway(registry, sandbox, toolDcEngine, logStore, config.provider);

  // Auto-seed benchmark data if database is empty on boot
  const initialSummary = logStore.getSummary();
  if (initialSummary.total_requests === 0) {
    console.log('[AEL Server] Empty decision log detected. Running initial verification benchmark suites...');
    await runToolEvalSuite(logStore);
    await runBudgetEvalSuite(logStore, 'held_out');
    console.log('[AEL Server] Seeded verified benchmark data into SQLite decision log.');
  }

  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------
  // SURFACE 1: LLM API Proxy (/v1/chat/completions & /v1/messages)
  // -------------------------------------------------------------
  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const { messages, model, user, stream } = req.body;
      const lastUserMsg = (messages || []).slice().reverse().find((m: any) => m.role === 'user')?.content || '';
      
      const workflow_id = (req.headers['x-workflow-id'] as string) || (user ? `user_${user}` : 'default_workflow');
      const task_category = (req.headers['x-task-category'] as string) || 'general';

      const result = await budgetEngine.routeAndExecute(lastUserMsg, {
        workflow_id,
        task_category,
        policy: activePreset,
        pass_through: config.pass_through,
      });

      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || config.provider.default_model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(lastUserMsg.length / 4),
          completion_tokens: Math.ceil(result.text.length / 4),
          total_tokens: result.total_tokens,
          reasoning_tokens: result.total_tokens - (Math.ceil(lastUserMsg.length / 4) + Math.ceil(result.text.length / 4)),
        },
        ael_economics: {
          regime: result.regime,
          effort: result.final_effort,
          confidence_signal: result.confidence_signal,
          baseline_tokens: result.baseline_tokens,
          net_tokens_saved: Math.max(0, result.baseline_tokens - result.total_tokens),
          baseline_cost_usd: result.baseline_cost_usd,
          actual_cost_usd: result.total_cost_usd,
          net_cost_saved_usd: result.net_cost_saved_usd,
          circuit_breaker_tripped: result.circuit_breaker_tripped,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/v1/messages', async (req, res) => {
    try {
      const { messages, model } = req.body;
      const lastUserMsg = (messages || []).slice().reverse().find((m: any) => m.role === 'user')?.content || '';
      const workflow_id = (req.headers['x-workflow-id'] as string) || 'anthropic_workflow';

      const result = await budgetEngine.routeAndExecute(lastUserMsg, {
        workflow_id,
        policy: activePreset,
        pass_through: config.pass_through,
      });

      res.json({
        id: `msg-${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: result.text }],
        model: model || config.provider.default_model,
        usage: {
          input_tokens: Math.ceil(lastUserMsg.length / 4),
          output_tokens: Math.ceil(result.text.length / 4),
        },
        ael_economics: {
          confidence_signal: result.confidence_signal,
          net_tokens_saved: Math.max(0, result.baseline_tokens - result.total_tokens),
          net_cost_saved_usd: result.net_cost_saved_usd,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // -------------------------------------------------------------
  // SURFACE 2: MCP Gateway Endpoints
  // -------------------------------------------------------------
  app.get('/mcp/tools', (req, res) => {
    const q = req.query.q as string | undefined;
    res.json({ tools: mcpGateway.discoverTools(q), schema_hash: registry.getSchemaHash() });
  });

  app.get('/mcp/tools/:name', (req, res) => {
    try {
      res.json(mcpGateway.getToolSchema(req.params.name));
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/mcp/smart_action', async (req, res) => {
    try {
      const { query, workflow_id, human_approval_granted } = req.body;
      const result = await mcpGateway.smartAction(query, {
        workflow_id,
        human_approval_granted: Boolean(human_approval_granted),
        pass_through: config.pass_through,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/mcp/execute', async (req, res) => {
    try {
      const { tool, arguments: args, human_approval_granted } = req.body;
      const result = await mcpGateway.executeTool(tool, args || {}, Boolean(human_approval_granted));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // -------------------------------------------------------------
  // FROZEN DASHBOARD API (Strictly two read-only endpoints)
  // -------------------------------------------------------------
  app.get('/api/metrics/summary', (req, res) => {
    res.json(logStore.getSummary());
  });

  app.get('/api/metrics/decisions', (req, res) => {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 15;
    res.json(logStore.getRecentDecisions(page, limit));
  });

  // Evaluation trigger endpoint
  app.post('/api/eval/run', async (req, res) => {
    try {
      const suite = req.body.suite || 'all';
      let toolRes = null;
      let budgetRes = null;

      if (suite === 'tool' || suite === 'all') {
        toolRes = await runToolEvalSuite(logStore);
      }
      if (suite === 'budget' || suite === 'all') {
        budgetRes = await runBudgetEvalSuite(logStore, 'held_out');
      }

      res.json({
        success: true,
        tool_eval: toolRes,
        budget_eval: budgetRes,
        summary: logStore.getSummary(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // -------------------------------------------------------------
  // Vite Integration / Static Frontend Serving
  // -------------------------------------------------------------
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : config.port;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AEL] Agent Economics Layer listening on http://0.0.0.0:${PORT}`);
    console.log(`[AEL] Dashboard served at http://0.0.0.0:${PORT}/dashboard`);
    console.log(`[AEL] Active preset: "${config.active_preset}"`);
  });
}

startServer().catch(err => {
  console.error('[AEL Server] Fatal error starting server:', err);
  process.exit(1);
});
