# AEL — Agent Economics Layer (v0.1.0 Architecture & Implementation Plan)

A self-hosted economic middleware written in TypeScript (Node.js 22 LTS, Express) that sits between an AI agent framework and its resources (LLM APIs + MCP tool servers). AEL enforces two core economic decisions on every request:
1. **Tool Selection (Tool-DC)**: Training-free "Try-Check-Retry" divide-and-conquer loop (based on Tool-DC, arXiv:2603.11495) with programmatic validation and dry-run safety verification governed by author-declared execution contracts.
2. **Thinking Budget (AERA & CoBa)**: Adaptive test-time compute allocation (based on AERA, arXiv:2608.27964) and compute-balanced routing (based on CoBa, arXiv:2608.07424) across Single, Sample, and Search test-time scaling regimes (arXiv:2608.04001) governed by a 4-level confidence signal taxonomy and protected by a negative-savings circuit breaker.

---

## Definition of Done (Acceptance Criteria)

The v0.1.0 release is complete when all of the following criteria are met and validated:

1. **Tool-Selection Accuracy**: $\ge 90\%$ accuracy on the tool evaluation suite within $\le 3$ retries.
2. **Dry-Run Safety Catches**: $\ge 3$ demonstrated dry-run catches of wrong tools or invalid argument payloads before side effects occur.
3. **Compute Efficiency & Net Savings**: $\ge 50\%$ reasoning token reduction with $\le 2\text{pp}$ accuracy drop compared to the fixed-high-effort baseline on the held-out split, accounting for all internal AEL overhead in net savings calculations.
4. **Headline Cost Metric**: Demonstrated reduction in **USD per successful completed task** (baseline vs AEL) reported across evaluation suites, CLI reports, and dashboard.
5. **Evaluation Diversity**: The budget evaluation suite spans at least 4 mixed-difficulty task categories with a dedicated held-out split (never used for tuning prompts or thresholds), reporting both net savings and accuracy per category.
6. **Negative-Savings Circuit Breaker**: Verified automatic trip to pass-through mode when a workflow's rolling net savings fall $\le 0$ or accuracy drop exceeds policy threshold.
7. **Middleware Overhead**: p95 decision overhead $< 500\text{ms}$ (excluding upstream network calls).
8. **End-to-End Demonstration**: Working runnable end-to-end demo with an AI agent framework in `examples/`.
9. **Code Quality & Testing**: Vitest suite with $\ge 80\%$ test coverage on engines and data models, clean `tsc --strict`, and clean ESLint.

---

## User Review & Critical Decisions

- **Runtime & Persistence**: Full-stack TypeScript 5.x strict mode on Node.js 22 LTS with Express. Decision log persistence is backed by `better-sqlite3`.
- **Net Savings Accounting**:
  - Every decision records upstream costs PLUS AEL's own internal costs (selection calls, dry-run judge, evidence sampling, escalations) in tokens and USD.
  - $\text{Net Savings} = \text{Baseline Cost} - (\text{Upstream Cost} + \text{AEL Internal Cost})$.
  - CLI reports, dashboard KPIs, and README headline all use **Net Savings** and report **USD per successful completed task**.
- **Negative-Savings Circuit Breaker**:
  - Maintained per workflow over a rolling window (default: last 20 requests).
  - If rolling net savings $\le 0$ or accuracy drop exceeds policy threshold, AEL automatically trips that workflow to pass-through mode, logs a warning entry, and surfaces the tripped state in `ael report` and the dashboard.
  - Configurable, enabled by default: AEL never silently loses money on any workflow.
- **Author-Declared Execution Contracts (No LLM Inference)**: Every tool carries an author-declared contract:
  - `dry_run_support`: `"real" | "simulated" | "none"` (never inferred by LLM).
  - `side_effect`: `"none" | "idempotent" | "mutating"`.
  - `reversible`: boolean (`reversal_tool_ref` optional string).
  - `requires_human_approval`: boolean for high-risk / destructive actions.
  - `idempotency_key`: optional argument name guaranteeing at-most-once execution.
  - *Sandbox Rules*: Real dry-runs execute ONLY when `dry_run_support="real"` AND `side_effect` is `"none"` or `"idempotent"`. Mutating tools never execute in dry-run (schema validation and argument judge only). Validation never equals authorization: tools requiring human approval require an explicit authorization confirmation flag regardless of validation success.
- **4-Level Confidence Signal Taxonomy**: Decisions and telemetry classify evidence into four non-equivalent tiers:
  1. `externally_verified`: Programmatic test, dry-run outcome, or deterministic checker.
  2. `model_confidence`: Provider-reported logprobs / token-level confidence metrics.
  3. `consensus`: Agreement among $k$ samples (stopping heuristic only; never labeled as "verified").
  4. `insufficient_evidence`: Escalation trigger or policy-defined halt.
- **Privacy & Telemetry**: `telemetry.log_payloads` defaults to `false`. User/session identifiers are hashed or truncated in log entries. No prompt text or tool payloads are stored unless explicitly opted-in by configuration.
- **Provider-Agnostic with Graceful Degradation**: OpenAI-compatible and Anthropic-style adapters. If an upstream provider or model lacks reasoning-effort controls, AEL logs a warning and proceeds without crashing the request path.
- **Cache Invalidation**: Tool-selection candidate batches and execution caches are keyed by a cryptographic hash of the active toolset schema (`schema_hash`). Changes in tool schemas trigger immediate cache invalidation.
- **Dashboard Scope (Strictly Frozen for v1)**:
  - Exactly **ONE read-only page** served at `/dashboard` (and `/`).
  - Displays exclusively: Savings KPIs (net tokens, net USD, % vs baseline, USD per completed task), tool-selection accuracy from evals, escalation distribution, p50/p95 latency, circuit-breaker status, and a paginated recent-decisions table.
  - Sourced from two read-only endpoints: `GET /api/metrics/summary` and `GET /api/metrics/decisions`.
  - Zero write endpoints, zero auth, zero settings UI, zero websockets, zero multi-tenant.
  - Recharts for visualizations; tabular figures (`tabular-nums`) and anti-slop visual discipline.
  - Primary reporting interface remains the CLI (`ael report`).

---

## 1. Overview & Core Concept

### Context & Scientific Foundation
- **Tool-DC (arXiv:2603.11495)**: Decompose candidate tools into focused subsets, propose structured calls, check schemas and non-mutating executions, and retry with reflection. Reported up to +25.10% average gains under lab conditions.
- **AERA (arXiv:2608.27964)**: Dynamically sizes compute per query based on evidence residual rather than applying static reasoning budgets. Reported ~92.61% vs 93.01% accuracy while reducing completion tokens by 95.99% under lab benchmarks.
- **CoBa (arXiv:2608.07424)**: Compute-balanced routing treating test-time compute as an allocation among Generate, Verify, and Stop actions.
- **Test-Time Scaling Regimes (arXiv:2608.04001)**: Single trajectory, Sample majority voting, and Search states.

---

## 2. Integration & Interception Contract

AEL v1.0.0 provides exactly two integration surfaces and no embedded SDK:

| Surface | Target Agents | Interception Mechanism | Capabilities Supported |
| :--- | :--- | :--- | :--- |
| **MCP Gateway** | MCP-native agents (Claude Code, Cursor, LangGraph + MCP, custom MCP clients) | Client points MCP connection to AEL gateway URL; AEL exposes meta-tools (`discover_tools`, `get_tool_schema`, `execute_tool`, `smart_action`) | Full Tool-DC (divide, try, check, dry-run, retry) + Budget Engine |
| **LLM API Proxy** | Any agent framework using standard OpenAI or Anthropic SDKs | Set `baseURL` to AEL proxy endpoint (`/v1/chat/completions` or `/v1/messages`) | Thinking Budget Engine (AERA/CoBa adaptive compute, cheap-first probe, escalation) |

### Non-Goals & Boundaries for v1
- **Native Function-Calling Interception**: Rewriting the `tools` array / intercepting raw `tool_calls` inside standard completion requests is explicitly deferred to v1.1 (documented in `CHANGELOG.md`).
- **Embedded SDK**: AEL is exclusively a self-hosted standalone service / proxy; there is no in-process library SDK.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             AI Agent Framework                              │
│                    (LangChain, LlamaIndex, Claude Code, etc.)               │
└───────────────────────┬───────────────────────────────┬─────────────────────┘
                        │ LLM Proxy: /v1/chat /v1/msg   │ MCP Gateway: JSON-RPC
                        ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AEL — Agent Economics Layer Middleware                   │
│                                                                             │
│  ┌───────────────────────────────┐     ┌──────────────────────────────────┐ │
│  │   Thinking Budget Engine      │     │      Tool Selection Engine       │ │
│  │     (AERA & CoBa Routers)     │     │       (Tool-DC Finite State)     │ │
│  │  - Cheap-First Probe          │     │  - Author Execution Contracts    │ │
│  │  - 4-Tier Confidence Signals  │     │  - Semantic Batch Retriever      │ │
│  │  - Circuit Breaker (Rolling)  │     │  - Propose (Tool + Args)         │ │
│  │  - Single / Sample / Search   │     │  - Check (Schema + Dry-Run Safe) │ │
│  │  - Graceful Degradation       │     │  - Narrow & Retry Loop (max 3)   │ │
│  └───────────────┬───────────────┘     └─────────────────┬────────────────┘ │
│                  │                                       │                  │
│                  ▼                                       ▼                  │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                  Unified SQLite Decision Log (better-sqlite3)          │ │
│  │     - Net Savings = Baseline - (Upstream + AEL Internal Overhead)      │ │
│  │     - Privacy: log_payloads=false, hashed identifiers, schema_hash     │ │
│  │     - Taxonomy: externally_verified | model_conf | consensus | insuff  │ │
│  │     - KPI: USD per successful completed task (baseline vs AEL)         │ │
│  └───────────────────────────────────────┬────────────────────────────────┘ │
└──────────────────────────────────────────┼──────────────────────────────────┘
                                           │
                        ┌──────────────────┴──────────────────┐
                        ▼                                     ▼
        ┌──────────────────────────────┐     ┌──────────────────────────────┐
        │       CLI Interface          │     │ Frozen Read-Only Dashboard   │
        │ - `ael report` (Net ROI)     │     │ - GET /api/metrics/summary   │
        │ - `ael eval --suite <name>`  │     │ - GET /api/metrics/decisions │
        │ - `ael serve` (gateway)      │     │ - Served at /dashboard & /   │
        └──────────────────────────────┘     └──────────────────────────────┘
```

---

## 3. Phased Implementation Roadmap

### Phase 1: MCP Gateway Core, Config & Reusable Mock Tool Servers
- **Config & Presets**: Zod schemas for system configuration, provider profiles, circuit breaker policies, and named presets (`quality_first`, `balanced`, `cost_saver`, `latency_capped`).
- **Tool Registry with Author-Declared Execution Contracts**:
  - `ToolRecord` schema with `dry_run_support`, `side_effect`, `reversible`, `requires_human_approval`, `idempotency_key`.
  - Schema hashing (`schema_hash`) for toolset change detection and instant cache invalidation.
- **Meta-Tools**: Implementation of `discover_tools`, `get_tool_schema`, `execute_tool`, and `smart_action`.
- **Pass-Through & A/B Mode**: Configurable pass-through mode to enable baseline comparison benchmarks.
- **Reusable Mock MCP Servers (`evals/` & `examples/`)**:
  - `filesystem_server`: Read, write, list files with author-declared dry-run support.
  - `search_server`: Mock search indexing with query parameters and simulated results.
  - `destructive_server`: High-risk financial/system tools (`side_effect: "mutating"`, `requires_human_approval: true`, `dry_run_support: "none"`).

### Phase 2: Tool-DC Engine, Dry-Run Sandbox & Tool Selection Eval Suite
- **Tool-DC Finite State Machine**:
  - *Divide*: Semantic candidate batch retriever using token/metadata indexing and category grouping.
  - *Try*: Batch prompt construction requesting tool selection + JSON arguments.
  - *Check*: Two-tier verification:
    1. Strict JSON schema validation (types, required fields, constraints).
    2. Dry-run sandbox enforcement: real execution permitted ONLY for `dry_run_support="real"` and `side_effect in ["none", "idempotent"]`. Mutating tools receive structural/judge checks only; authorization requires explicit human confirmation flag.
  - *Retry*: Structured reflection loop passing validation/dry-run errors back to the model (up to 3 attempts).
- **Internal Overhead Accounting**: Tracking internal prompt/completion tokens and costs for tool selection batches and dry-run judges.
- **Cache Layer**: Caching valid tool plans keyed by query intent and `schema_hash`.
- **Gate Milestone**: Run and pass tool-selection eval suite:
  - $\ge 90\%$ accuracy within $\le 3$ retries.
  - $\ge 3$ demonstrated dry-run catches of wrong tools.

### Phase 3: LLM Proxy Surfaces, Budget Engine (AERA/CoBa) & Budget Eval Suite
- **Proxy Endpoints**: Express routes for `/v1/chat/completions` (OpenAI format) and `/v1/messages` (Anthropic format).
- **Provider-Agnostic LLM Client**: OpenAI-compatible and Anthropic-style adapters with token and cost tracking; graceful degradation when reasoning controls are unsupported.
- **Negative-Savings Circuit Breaker**:
  - Sliding window of 20 requests per workflow.
  - Automatic transition to pass-through mode if rolling net savings $\le 0$ or error rate exceeds threshold.
- **4-Level Confidence Signal Taxonomy**:
  - Classify evidence into `externally_verified`, `model_confidence`, `consensus`, or `insufficient_evidence`.
  - Document explicitly that `consensus` is a stopping heuristic, not a correctness proof.
- **AERA Cheap-First Engine & CoBa Controller**:
  - Execute minimal-compute probe; evaluate evidence residual; dynamically allocate Generate/Verify/Stop.
  - Internal cost accounting: record tokens and costs consumed by probes, verifiers, and judges.
- **Evaluation Diversity (Eval Suite)**:
  - 4 mixed-difficulty task categories: factual lookup, multi-step math/logic, code synthesis/debugging, and structured data extraction.
  - Separate tuning split and held-out evaluation split.
  - Net savings and accuracy measured and reported per category.
- **Gate Milestone**: Run and pass budget eval suite:
  - $\ge 50\%$ reasoning token reduction with $\le 2\text{pp}$ accuracy drop vs fixed-high-effort baseline on held-out split (with positive net USD savings).
  - p95 decision overhead $< 500\text{ms}$.

### Phase 4: Telemetry, CLI, Frozen Dashboard & Release Artifacts
- **Decision Log (`better-sqlite3`)**:
  - Schema tracking tokens (input, output, reasoning), cost (upstream, internal AEL, net savings), latency, accuracy, circuit breaker events, and USD per completed task.
  - Privacy safeguards: `log_payloads` default `false`, hashed identifiers.
- **CLI (`bin/ael.ts`)**:
  - `ael report`: Formatted summary tables, net ROI, circuit breaker status, and USD per successful completed task.
  - `ael eval --suite <name>`: Runs benchmark suites and emits structured JSON/Markdown reports.
  - `ael serve`: Starts the middleware proxy and dashboard server.
- **Frozen Read-Only Dashboard (`/dashboard`)**:
  - React + Recharts frontend backed strictly by `GET /api/metrics/summary` and `GET /api/metrics/decisions`.
  - Visual display of net savings KPIs (tokens, USD, % vs baseline, USD per completed task), tool accuracy, escalation distribution, p50/p95 latency, circuit breaker status banner, and recent decisions table.
- **End-to-End Demo (`examples/`)**: Working agent workflow script demonstrating AEL intercepting requests, catching faulty tool calls, and saving compute.
- **Release Documentation & Packaging**:
  - `README.md` with integration table, benchmark results from actual evaluation runs (savings & accuracy per category, USD per completed task, suite composition, and paper mapping).
  - 500–800 word launch blog draft (`docs/launch_blog.md`).
  - `DECISIONS.md`, `CHANGELOG.md` (with v1.1 function-calling interception noted), `LICENSE` (Apache-2.0), `Dockerfile`, and GitHub Actions workflow (`.github/workflows/ci.yml`).
