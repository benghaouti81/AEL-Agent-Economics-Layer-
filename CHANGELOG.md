# Changelog — AEL (Agent Economics Layer)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-11-10

### Added
- **Tool-DC Finite State Machine (arXiv:2603.11495)**:
  - Divide-and-conquer candidate batch retriever using semantic keyword indexing.
  - Try-Check-Retry loop with programmatic JSON Schema validation and safe dry-run execution.
  - Author-declared execution contracts (`dry_run_support`, `side_effect`, `reversible`, `requires_human_approval`, `idempotency_key`).
  - Dynamic `schema_hash` invalidating tool plan caches whenever toolset changes.
- **AERA & CoBa Thinking Budget Engine (arXiv:2608.27964, arXiv:2608.07424)**:
  - Cheap-first probe allocating minimal compute initially.
  - Evidence residual check and CoBa controller dynamically allocating Generate, Verify, and Stop actions.
  - Scaling regimes support: `Single` (reasoning effort ladder), `Sample` (self-consistency consensus), and `Search` (stub interface).
  - 4-tier confidence signal taxonomy (`externally_verified`, `model_confidence`, `consensus`, `insufficient_evidence`).
- **Negative-Savings Circuit Breaker**:
  - Rolling 20-request window per workflow monitoring net savings and error rates.
  - Automatic tripping to pass-through mode if rolling net savings $\le 0$.
- **Unified Decision Log Store (`better-sqlite3`)**:
  - Full net savings accounting: tracks upstream costs and internal AEL overhead tokens/USD.
  - Headline metric calculation: USD per successful completed task.
  - Privacy protections: `telemetry.log_payloads` default `false`, hashed workflow and query identifiers.
- **MCP Gateway & Meta-Tools**:
  - Exposes `discover_tools`, `get_tool_schema`, `execute_tool`, and `smart_action`.
  - Reusable mock MCP servers in `evals/mock_servers/` (filesystem, search, destructive actions).
- **LLM API Proxy Surfaces**:
  - OpenAI-compatible `/v1/chat/completions` request rewriting.
  - Anthropic-style `/v1/messages` request rewriting.
- **Evaluation Harness & CLI (`bin/ael.ts`)**:
  - `ael report`: Scannable economic savings report, overhead latency, and circuit breaker status.
  - `ael eval --suite <tool|budget>`: Benchmarking tool selection and budget efficiency across 4 categories and held-out splits.
  - `ael seed`: Seeds realistic benchmark runs.
- **Frozen Read-Only Web Console (`/dashboard`)**:
  - Single read-only dashboard powered by `GET /api/metrics/summary` and `GET /api/metrics/decisions`.
  - Recharts escalation distribution, latency breakdown, and paginated decision traces.

---

## [Planned for v1.1.0]

- **Native Function-Calling Interception**:
  - Intercepting and rewriting the `tools` array and raw `tool_calls` in standard OpenAI/Anthropic completion streams without requiring client MCP gateway adoption.
- **OpenTelemetry Exporter**:
  - Plug-and-play OTel tracing exporter implementing the `LogStore` interface.
- **Interactive CLI Playground (`ael playground`)**:
  - Interactive terminal REPL for testing prompt compute escalation and dry-run execution interactively.
- **Full Search Scaling Regime**:
  - Multi-path Monte Carlo tree search and state expansion over partial answer trajectories.
