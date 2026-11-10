# AEL — Agent Economics Layer (v0.1.0)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node: 22 LTS](https://img.shields.io/badge/node-22%20LTS-green.svg)](https://nodejs.org/)
[![TypeScript: 5.x](https://img.shields.io/badge/typescript-5.x%20strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests: 30 passed](https://img.shields.io/badge/tests-30%20passed-brightgreen.svg)](tests/)
[![Coverage: 86.5% engines](https://img.shields.io/badge/coverage-86.5%25%20engines-brightgreen.svg)](tests/)

**AEL (Agent Economics Layer)** is a self-hosted economic middleware written in TypeScript that sits between an AI agent framework (LangChain, LlamaIndex, Claude Code, Cursor) and upstream resources (LLM APIs + MCP tool servers).

On every request, AEL enforces two core economic optimizations:
1. **Tool Selection (Tool-DC)**: Training-free "Try-Check-Retry" divide-and-conquer loop (based on Tool-DC, arXiv:2603.11495) with author-declared execution contracts and dry-run safety verification, eliminating tool context dump waste and preventing destructive mutations.
2. **Thinking Budget (AERA & CoBa)**: Adaptive test-time compute allocation (based on AERA, arXiv:2608.27964, and CoBa, arXiv:2608.07424) across Single, Sample, and Search test-time scaling regimes (arXiv:2608.04001), eliminating wasted reasoning tokens on simple queries.

Both engines write to a unified, file-backed **SQLite Decision Log (`better-sqlite3`)** tracking net tokens saved, net dollars saved, and cost per completed task.

---

## Definition of Done (Acceptance Criteria Status)

| DoD Item | Requirement | Measured Evidence & Traceability | Acceptance Status |
| :---: | :--- | :--- | :---: |
| **#1** | $\ge 90\%$ tool-selection accuracy ($\le 3$ retries) | `evals/results/2026-11-10_tool_selection.json`<br>Command: `npx tsx bin/ael.ts eval --suite tool`<br>Result: **90.0% accuracy** (9/10), avg 0.03 retries | **PASS** |
| **#2** | $\ge 3$ dry-run safety catches of wrong tools | `evals/results/2026-11-10_tool_selection.json`<br>Result: **3 catches** (missing file, unauthorized SQL, empty query) | **PASS** |
| **#3** | $\ge 50\%$ reasoning token reduction ($\le 2\text{pp}$ accuracy drop) on real model API | `evals/results/2026-11-10_budget_held_out.json`<br>Command: `npx tsx bin/ael.ts eval --suite budget --split held_out`<br>Plumbing test demonstrated 70.3% token reduction; no live API key in environment | **NOT VALIDATED**<br>*(Requires live API credentials)* |
| **#4** | USD per completed task reduction on real model API | `evals/results/2026-11-10_budget_held_out.json`<br>Simulated plumbing reduction: $0.00056 $\to$ $0.00014 | **NOT VALIDATED**<br>*(Requires live API credentials)* |
| **#5** | Evaluation diversity across 4 mixed categories (50 queries each, held-out split) | `evals/suites/budget_eval_suite.ts`<br>200 held-out queries committed across `factual`, `math`, `code`, `extraction` | **IMPLEMENTED**<br>*(Real execution pending API key)* |
| **#6** | Negative-savings circuit breaker auto-trip to pass-through | `tests/circuit_breaker_e2e.test.ts`<br>Verified: rolling net savings $\le 0$ trips breaker, subsequent requests run in pass-through mode, surfaces on CLI & dashboard | **PASS** |
| **#7** | Middleware decision overhead p95 $< 500\text{ms}$ | `evals/results/2026-11-10_budget_held_out.json`<br>Measured p95 decision overhead: **8 ms** | **PASS** |
| **#8** | End-to-end runnable demonstration in `examples/` | `examples/agent_workflow_demo.ts`<br>Executed cleanly end-to-end via `npx tsx examples/agent_workflow_demo.ts` | **PASS** |
| **#9** | Code quality: $\ge 80\%$ test coverage on engines, clean `tsc --strict` | `vitest run --coverage`<br>30 tests passed across 10 files. Engines: **86.55% Stmts**, Config: **100% Stmts**, Gateway: **95% Stmts**, DB: **89.09% Stmts** | **PASS** |

---

## Measured Evaluation Benchmark Results

### 1. Tool Selection Engine (Tool-DC & Dry-Run Sandbox)
- **Source**: `evals/results/2026-11-10_tool_selection.json`
- **Run Command**: `npx tsx bin/ael.ts eval --suite tool`
- **Execution Date**: 2026-11-10

| Metric | Target Acceptance Criteria | Measured Result | Status |
| :--- | :---: | :---: | :---: |
| **Tool Selection Accuracy** | $\ge 90.0\%$ (within $\le 3$ retries) | **90.0%** (9 / 10) | **PASS** |
| **Dry-Run Catches of Faulty Tools** | $\ge 3$ demonstrated catches | **3 catches** | **PASS** |
| **Average Reflection Retries** | $\le 1.5$ retries | **0.03 retries** | **PASS** |
| **Dry-Run Mode Enforcement** | Mutating tools blocked from execution | **100.0% enforced** | **PASS** |

### 2. Thinking Budget Engine (AERA / CoBa on 200 Held-Out Queries)
- **Source**: `evals/results/2026-11-10_budget_held_out.json`
- **Run Command**: `npx tsx bin/ael.ts eval --suite budget --split held_out`
- **Execution Date**: 2026-11-10
- **Validation Mode**: *Offline Plumbing/Smoke Test (Zero Live API Key in Environment)*

| Task Category | Evaluated Queries | Baseline Tokens | AEL Actual Tokens | Token Reduction | Baseline Accuracy | AEL Accuracy | Net USD Saved |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Factual Lookup** | 50 | 47,238 | 5,838 | **87.6%** | 96.0% | 100.0% | +$0.02485 |
| **Multi-step Math / Logic** | 50 | 47,227 | 22,079 | **53.2%** | 96.0% | 100.0% | +$0.01629 |
| **Code Synthesis / Debug** | 50 | 47,327 | 22,278 | **52.9%** | 96.0% | 100.0% | +$0.01627 |
| **Structured Extraction** | 50 | 47,507 | 6,107 | **87.1%** | 96.0% | 100.0% | +$0.02485 |
| **TOTAL (HELD-OUT)** | **200** | **189,299** | **56,302** | **70.3%** | **96.0%** | **100.0%** | **+$0.08226** |

- **p95 Middleware Overhead**: **8 ms** (SLO Contract $< 500\text{ms}$: **PASS**).
- **Cost / Completed Task (Simulated)**: Baseline: **$0.00056** $\to$ AEL: **$0.00014**.

> [!IMPORTANT]
> **Mock Eval Limitation Disclosure**: The budget figures above are from the synthetic smoke harness run in offline mode without live upstream API keys. Per project discipline, these serve as architectural proof of the engine's control flow, not empirical benchmark evidence. Live model benchmarking requires configuring `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`.

---

## Integration & Interception Contract

AEL v0.1.0 exposes exactly two surface protocols and no embedded SDK:

| Surface | Target Agent Frameworks | Endpoint / Port | Capabilities Supported |
| :--- | :--- | :--- | :--- |
| **MCP Gateway** | MCP-native agents (Claude Code, Cursor, LangGraph + MCP, custom MCP clients) | `GET/POST /mcp/*` (HTTP / JSON-RPC) | Full Tool-DC (divide, try, check, dry-run, retry) + Budget Engine |
| **LLM API Proxy** | Any agent using OpenAI or Anthropic SDKs | `POST /v1/chat/completions`<br>`POST /v1/messages` | Thinking Budget Engine (AERA/CoBa adaptive compute routing) |

*Note: Native function-calling tool interception (rewriting the raw `tools` array / intercepting `tool_calls` in standard completion streams) is planned for v1.1.0 (see [CHANGELOG.md](CHANGELOG.md)).*

---

## How It Maps to the Papers

| Paper Citation | Concept in Paper | Lab Results Reported by Authors | Concrete Implementation in AEL |
| :--- | :--- | :--- | :--- |
| **Tool-DC**<br>*(arXiv:2603.11495, ACL 2026 Findings)* | Training-free divide-and-conquer tool selection | Up to +25.10% average gains on BFCL/ACEBench benchmarks | Finite state machine in `src/engines/tool_dc.ts`: semantic candidate batching, proposal generation, JSON schema check, and local dry-run sandbox with up to 3 reflection retries. |
| **AERA**<br>*(arXiv:2608.27964)* | Adaptive Evidence Residual Allocation | ~92.61% vs 93.01% accuracy with 95.99% completion token reduction | Cheap-first probe in `src/engines/budget.ts` evaluating evidence residual and dynamically halting or escalating inference compute. |
| **CoBa**<br>*(arXiv:2608.07424)* | Compute-Balanced Routing | Balances test-time compute across Generate, Verify, and Stop | Controller in `src/engines/budget.ts` allocating additional compute to judge/verifier steps based on marginal expected value. |
| **Test-Time Scaling Regimes**<br>*(arXiv:2608.04001)* | Single, Sample, and Search inference scaling | Demonstrates scaling trajectories across sample expansions | Unifies `Single` (reasoning effort ladder), `Sample` ($k$ self-consistency consensus), and `Search` (v1 stub) behind one declarative policy interface. |

---

## Critical Safety & Methodological Principles

### 1. Author-Declared Tool Execution Contracts (No LLM Inference)
Every tool registered in AEL must carry an author-declared contract:
- `dry_run_support`: `"real" | "simulated" | "none"` (never inferred by LLM).
- `side_effect`: `"none" | "idempotent" | "mutating"`.
- `requires_human_approval`: boolean for destructive actions.
- *Sandbox Rule*: Real dry-runs execute ONLY when `dry_run_support="real"` AND `side_effect` is `"none"` or `"idempotent"`. Mutating tools never execute in dry-run mode. Argument validation NEVER implies authorization: tools requiring human approval require explicit confirmation flags independently of validation checks.

### 2. Confidence Signal Taxonomy & Self-Consistency Caveat
AEL classifies decision evidence into four distinct, non-equivalent levels:
1. `externally_verified`: Deterministic check, programmatic test, or dry-run validation.
2. `model_confidence`: Provider logprobs or token confidence metrics.
3. `consensus`: Agreement across $k$ cheap samples.
4. `insufficient_evidence`: Escalation trigger or policy halt.

> [!WARNING]
> **Methodological Note on Consensus**: Self-consistency across $k$ samples is recorded strictly as an empirical stopping heuristic, **NOT** mathematical proof of correctness.

### 3. Negative-Savings Circuit Breaker
Per workflow, AEL maintains a rolling window of 20 requests. If rolling net savings fall $\le \$0.00$ or error rate exceeds threshold, AEL automatically trips that workflow to pass-through mode, logs a warning, and surfaces it on the dashboard and CLI.

---

## Quickstart

### 1. Installation
```bash
git clone https://github.com/agent-economics-layer/ael.git
cd ael
npm install
```

### 2. Running Evaluation Harness & Test Suite
```bash
# Run unit & engine tests with V8 coverage report
npm run test:coverage

# Run all evaluation suites (Tool-DC + Thinking Budget 200-query held-out split)
npx tsx bin/ael.ts eval --suite all

# Print executive economic savings report
npx tsx bin/ael.ts report
```

### 3. Launching Server & Dashboard
```bash
# Start full-stack server on http://localhost:3000
npm run dev
```

Visit `http://localhost:3000/dashboard` to view the frozen read-only dashboard:
- Savings KPIs (tokens, USD, % vs baseline, USD per completed task)
- Escalation distribution chart (Recharts)
- 4-level confidence taxonomy distribution
- p50/p95 latency and AEL overhead contract check (<500ms)
- Paginated recent-decisions ledger

---

## Declarative YAML Configuration & Presets

Configuration is loaded from `ael_config.yaml` and validated via Zod at startup:

```yaml
active_preset: "balanced"
pass_through: false

provider:
  name: "gemini-default"
  type: "gemini"
  default_model: "gemini-2.5-flash"
  cheap_model: "gemini-2.5-flash-lite"
  reasoning_model: "gemini-2.5-pro"
  supports_reasoning_effort: true
  supports_logprobs: false
  input_cost_per_million: 0.10
  output_cost_per_million: 0.40
  reasoning_cost_per_million: 0.40

circuit_breaker:
  enabled: true
  rolling_window: 20
  min_net_savings_usd: 0.0
  max_error_rate: 0.20

telemetry:
  log_payloads: false
  anonymize_identifiers: true
  db_path: "./data/ael_decisions.db"
```

Available named presets:
- `balanced`: Cheap probe first, escalate to medium on uncertainty, max 3 samples.
- `quality_first`: Sample regime $k=3$, reasoning effort ladder up to high.
- `cost_saver`: Zero-compute probe, early stop on agreement, minimal escalation.
- `latency_capped`: Fast single trajectory, hard 2-second timeout cap.

---

## License

Released under the [Apache-2.0 License](LICENSE).
