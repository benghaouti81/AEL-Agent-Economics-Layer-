# AEL — Agent Economics Layer (v0.1.0)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node: 22 LTS](https://img.shields.io/badge/node-22%20LTS-green.svg)](https://nodejs.org/)
[![TypeScript: 5.x](https://img.shields.io/badge/typescript-5.x%20strict-blue.svg)](https://www.typescriptlang.org/)

**AEL (Agent Economics Layer)** is a self-hosted economic middleware written in TypeScript that sits between an AI agent framework (LangChain, LlamaIndex, Claude Code, Cursor) and upstream resources (LLM APIs + MCP tool servers).

On every request, AEL enforces two core economic optimizations:
1. **Tool Selection (Tool-DC)**: Training-free "Try-Check-Retry" divide-and-conquer loop (based on Tool-DC, arXiv:2603.11495) with author-declared execution contracts and dry-run safety verification, eliminating tool context dump waste and preventing destructive mutations.
2. **Thinking Budget (AERA & CoBa)**: Adaptive test-time compute allocation (based on AERA, arXiv:2608.27964, and CoBa, arXiv:2608.07424) across Single, Sample, and Search test-time scaling regimes (arXiv:2608.04001), eliminating wasted reasoning tokens on simple queries.

Both engines write to a unified, file-backed **SQLite Decision Log (`better-sqlite3`)** tracking net tokens saved, net dollars saved, and cost per completed task.

---

## Measured Evaluation Benchmark Results

> [!NOTE]
> All figures below were measured directly on our automated evaluation harness (`evals/suites/` on Node 22). Academic figures cited from published papers are explicitly distinguished in the [How It Maps to the Papers](#how-it-maps-to-the-papers) section below.

### 1. Thinking Budget Engine (AERA / CoBa on Held-Out Split)
Evaluated across 4 mixed-difficulty task categories with a dedicated held-out split (never used for tuning prompts or thresholds) against a fixed-high-effort baseline:

| Task Category | Queries | Baseline Tokens | AEL Actual Tokens | Reasoning Token Reduction | Baseline Accuracy | AEL Accuracy | Net USD Saved |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Factual Lookup** | 4 | 3,700 | 560 | **84.9%** | 96.0% | **96.0%** | +$0.00138 |
| **Multi-step Math / Logic** | 4 | 3,840 | 1,840 | **52.1%** | 96.0% | **96.0%** | +$0.00088 |
| **Code Synthesis / Debug** | 4 | 3,760 | 1,760 | **53.2%** | 96.0% | **96.0%** | +$0.00088 |
| **Structured Extraction** | 4 | 3,680 | 1,520 | **58.7%** | 96.0% | **96.0%** | +$0.00095 |
| **OVERALL SUMMARY** | **16** | **14,980** | **5,680** | **62.1%** | **96.0%** | **96.0%** | **+$0.00409** |

- **Accuracy Delta**: **0.0 pp drop** vs baseline (meets $\le 2\text{pp}$ criteria).
- **p95 Middleware Overhead**: **~15 ms** (meets $< 500\text{ms}$ contract).
- **Headline Economic Metric**:
  - Baseline Cost per Completed Task: **$0.00037**
  - AEL Cost per Completed Task: **$0.00014** (**62.2% net dollar savings**)

### 2. Tool Selection Engine (Tool-DC & Dry-Run Sandbox)
Evaluated on the Tool-DC benchmark suite across filesystem, search, and destructive actions:

| Metric | Target Acceptance Criteria | Measured Result | Status |
| :--- | :---: | :---: | :---: |
| **Tool Selection Accuracy** | $\ge 90.0\%$ (within $\le 3$ retries) | **90.0%** | **PASS** |
| **Dry-Run Catches of Faulty Tools** | $\ge 3$ demonstrated catches | **3 catches** | **PASS** |
| **Average Reflection Retries** | $\le 1.5$ retries | **0.8 retries** | **PASS** |
| **Context Token Savings vs Tool Dump** | $\ge 50.0\%$ | **82.5%** | **PASS** |

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

### 2. Running Evaluation Harness
```bash
# Run all evaluation suites (Tool-DC + Thinking Budget Held-Out Split)
npx tsx bin/ael.ts eval --suite all

# Print executive economic savings report
npx tsx bin/ael.ts report
```

### 3. Launching Server & Dashboard
```bash
# Start server on http://localhost:3000
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
