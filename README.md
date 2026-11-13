# AEL — Agent Economics Layer (v0.1.0)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node: 22 LTS](https://img.shields.io/badge/node-22%20LTS-green.svg)](https://nodejs.org/)
[![TypeScript: 5.x](https://img.shields.io/badge/typescript-5.x%20strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests: 34 passed](https://img.shields.io/badge/tests-34%20passed-brightgreen.svg)](tests/)
[![Coverage: 86.9% engines](https://img.shields.io/badge/coverage-86.9%25%20engines-brightgreen.svg)](tests/)

**AEL (Agent Economics Layer)** is a self-hosted economic middleware written in TypeScript that sits between an AI agent framework (LangChain, LlamaIndex, Claude Code, Cursor) and upstream resources (LLM APIs + MCP tool servers).

On every request, AEL enforces two core economic optimizations:
1. **Tool Selection (Tool-DC)**: Training-free "Try-Check-Retry" divide-and-conquer loop (based on Tool-DC, arXiv:2603.11495) with author-declared execution contracts and dry-run safety verification, eliminating tool context dump waste and preventing destructive mutations.
2. **Thinking Budget (AERA & CoBa)**: Adaptive test-time compute allocation (based on AERA, arXiv:2608.27964, and CoBa, arXiv:2608.07424) across Single, Sample, and Search test-time scaling regimes (arXiv:2608.04001), eliminating wasted reasoning tokens on simple queries.

Both engines write to a unified, file-backed **SQLite Decision Log (`better-sqlite3`)** tracking net tokens saved, net dollars saved, and cost per completed task.

---

## Definition of Done (Acceptance Criteria Status)

| DoD Item | Requirement | Measured Evidence & Traceability | Acceptance Status |
| :---: | :--- | :--- | :---: |
| **#1** | $\ge 90\%$ tool-selection accuracy ($\le 3$ retries) on real model API | `evals/results/2026-11-13_tool_selection.json` (`provider_source: mock_simulator`)<br>Command: `AEL_ALLOW_MOCK=1 npx tsx bin/ael.ts eval --suite tool`<br>Offline smoke result: **90.0% accuracy (9/10)**, avg **0** retries across 10 selection cases (13 total cases = 10 selection + 3 dry-run catch) | **NOT VALIDATED**<br>*(Smoke run via `mock_simulator`; live model eval pending)* |
| **#2** | $\ge 3$ dry-run safety catches of wrong tools | `evals/results/2026-11-13_tool_selection.json` (`provider_source: mock_simulator`)<br>Offline smoke result: **3/3 catches** (missing file, unauthorized SQL, empty query) | **NOT VALIDATED**<br>*(Smoke run via `mock_simulator`; live model eval pending)* |
| **#3** | $\ge 50\%$ reasoning token reduction ($\le 2\text{pp}$ accuracy drop) on real model API | `evals/results/2026-11-13_budget_held_out.json` (`provider_source: mock_simulator`)<br>Command: `AEL_ALLOW_MOCK=1 npx tsx bin/ael.ts eval --suite budget --split held_out`<br>Offline smoke result: **69.2% token reduction (130966/189162)**; no live API key in environment | **NOT VALIDATED**<br>*(Requires live API credentials)* |
| **#4** | USD per completed task reduction on real model API | `evals/results/2026-11-13_budget_held_out.json` (`provider_source: mock_simulator`)<br>Offline smoke result: **$0.00056** $\to$ **$0.00015** per task (+$0.08109 net saved across 200 queries) | **NOT VALIDATED**<br>*(Requires live API credentials)* |
| **#5** | Evaluation diversity across 4 mixed categories (50 queries each, held-out split) | `evals/suites/budget_eval_suite.ts` + `evals/results/2026-11-13_budget_held_out.json`<br>200 held-out queries (`50/50` factual, `50/50` math, `50/50` code, `50/50` extraction) | **NOT VALIDATED**<br>*(Dataset implemented; live execution pending API key)* |
| **#6** | Negative-savings circuit breaker auto-trip to pass-through | `tests/circuit_breaker_e2e.test.ts`<br>Verified in CI: rolling net savings $\le 0$ trips breaker, subsequent requests run in pass-through mode, surfaces on CLI & dashboard | **PASS** |
| **#7** | Middleware decision overhead p95 $< 500\text{ms}$ | `evals/results/2026-11-13_budget_held_out.json` (`overall_p95_overhead_ms`)<br>Measured p95 decision overhead (`performance.now()` excluding LLM I/O): **0 ms** | **PASS** |
| **#8** | End-to-end runnable demonstration in `examples/` | `examples/agent_workflow_demo.ts`<br>Executed cleanly end-to-end via `AEL_ALLOW_MOCK=1 npx tsx examples/agent_workflow_demo.ts` | **PASS** |
| **#9** | Code quality: $\ge 80\%$ test coverage on engines, clean `tsc --strict` | `vitest run --coverage`<br>34 tests passed across 10 files. Engines: **86.9% Stmts**, Config: **100% Stmts**, Gateway: **95% Stmts**, DB: **89.09% Stmts** | **PASS** |

---

## Measured Evaluation Benchmark Results

### 1. Tool Selection Engine (Tool-DC & Dry-Run Sandbox — Offline Smoke Run)
- **Source**: `evals/results/2026-11-13_tool_selection.json`
- **Run Command**: `npx tsx bin/ael.ts eval --suite tool` *(with `AEL_ALLOW_MOCK=1`)*
- **Execution Date**: 2026-11-13
- **Provider Source**: `mock_simulator` (`NOT VALIDATED (No live upstream API credentials configured)`)

| Metric | Target Acceptance Criteria | Measured Result | Status |
| :--- | :---: | :---: | :---: |
| **Tool Selection Accuracy** | $\ge 90.0\%$ (within $\le 3$ retries) | **90.0% (9/10)** *(source: `2026-11-13_tool_selection.json`)* | **NOT VALIDATED** *(Smoke threshold met)* |
| **Dry-Run Catches of Faulty Tools** | $\ge 3$ demonstrated catches | **3/3 catches** *(source: `2026-11-13_tool_selection.json`)* | **NOT VALIDATED** *(Smoke threshold met)* |
| **Average Reflection Retries** | $\le 1.5$ retries | **0 retries** *(0/10 selection cases; source: `2026-11-13_tool_selection.json`)* | **NOT VALIDATED** *(Smoke threshold met)* |
| **Dry-Run Mode Enforcement** | Mutating tools blocked from execution | **100.0% enforced** *(1/1 mutating tool `fin_transfer_funds` blocked as `schema_only`; source: `2026-11-13_tool_selection.json`)* | **NOT VALIDATED** *(Smoke threshold met)* |

### 2. Thinking Budget Engine (AERA / CoBa on 200 Held-Out Queries — Offline Smoke Run)
- **Source**: `evals/results/2026-11-13_budget_held_out.json`
- **Run Command**: `npx tsx bin/ael.ts eval --suite budget --split held_out` *(with `AEL_ALLOW_MOCK=1`)*
- **Execution Date**: 2026-11-13
- **Provider Source**: `mock_simulator` (`NOT VALIDATED (No live upstream API credentials configured)`)
- **Dataset Composition**: 200 distinct, high-difficulty queries with zero template cycling:
  - **Factual (50 distinct)**: Multi-hop history, astrophysics, biochemistry, sovereign treaties, cryptography, linguistics.
  - **Math (50 distinct)**: Modular arithmetic, differential equations, Markov chains, probability, linear algebra, number theory.
  - **Code (50 distinct)**: Lock-free ring buffers, topological sort, LRU caches, reactive observables, AST visitors, async pools.
  - **Extraction (50 distinct)**: Nested B2B invoices, clinical vitals, git merge conflicts, Kubernetes audit logs, SEC 10-K filings.

| Task Category | Evaluated Queries | Baseline Tokens | AEL Actual Tokens | Token Reduction | Baseline Accuracy | AEL Accuracy | Net USD Saved |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Factual Lookup** | 50 unique | 47,345 | 7,916 | **83.3%** (`39429/47345`) | 96.0% | 100.0% (`50/50`) | +$0.02381 |
| **Multi-step Math / Logic** | 50 unique | 47,103 | 21,830 | **53.7%** (`25273/47103`) | 96.0% | 100.0% (`50/50`) | +$0.01631 |
| **Code Synthesis / Debug** | 50 unique | 47,181 | 21,989 | **53.4%** (`25192/47181`) | 96.0% | 100.0% (`50/50`) | +$0.01629 |
| **Structured Extraction** | 50 unique | 47,533 | 6,461 | **86.4%** (`41072/47533`) | 96.0% | 100.0% (`50/50`) | +$0.02467 |
| **TOTAL (HELD-OUT)** | **200 distinct** | **189,162** | **58,196** | **69.2%** (`130966/189162`) | **96.0%** | **100.0%** (`200/200`) | **+$0.08109** |

- **p95 Middleware Overhead**: **0 ms** (measured via `performance.now()` excluding LLM I/O; SLO Contract $< 500\text{ms}$: **PASS**; source: `2026-11-13_budget_held_out.json`).
- **Cost / Completed Task (Offline Smoke)**: Baseline: **$0.00056** $\to$ AEL: **$0.00015** *(source: `2026-11-13_budget_held_out.json`)*.

> [!IMPORTANT]
> **Mock Eval Limitation Disclosure**: The figures above are from the offline synthetic smoke harness (`provider_source: mock_simulator`, `acceptance_status: NOT VALIDATED`) using 200 distinct handcrafted held-out prompts and 13 Tool-DC cases. Per project discipline, these serve as plumbing/control-flow smoke tests, not empirical model benchmark evidence. Live model benchmarking requires configuring `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`.

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

# Run all evaluation suites in offline smoke mode (Tool-DC + Thinking Budget 200-query held-out split)
AEL_ALLOW_MOCK=1 npx tsx bin/ael.ts eval --suite all

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
