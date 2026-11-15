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

## Definition of Done (Acceptance Criteria Status)

> [!NOTE]
> AEL does not include any synthetic or simulated LLM evaluation mode. Live benchmark criteria (**#1–#5**) remain **NOT RUN** until executed against real upstream provider credentials (`GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`) and validated by `evals/suites/benchmark_validator.ts`.

| DoD Item | Requirement | Evidence & Traceability | Acceptance Status |
| :---: | :--- | :--- | :---: |
| **#1** | $\ge 90\%$ tool-selection accuracy ($\le 3$ retries) on real model API | `evals/suites/tool_eval_suite.ts`<br>Requires live provider credentials (`npx tsx bin/ael.ts eval --suite tool`) | **NOT RUN**<br>*(Requires live API credentials)* |
| **#2** | $\ge 3$ dry-run safety catches of wrong tools | `evals/suites/tool_eval_suite.ts` + `tests/tool_dc.test.ts`<br>Deterministic sandbox catches verified in unit tests; full live benchmark requires provider credentials | **NOT RUN**<br>*(Requires live API credentials)* |
| **#3** | $\ge 50\%$ reasoning token reduction ($\le 2\text{pp}$ accuracy drop, quality floor $\ge 50\%$) on real model API | `evals/suites/budget_eval_suite.ts`<br>Requires live provider credentials (`npx tsx bin/ael.ts eval --suite budget --split held_out`) | **NOT RUN**<br>*(Requires live API credentials)* |
| **#4** | USD per completed task reduction on real model API | `evals/suites/budget_eval_suite.ts`<br>Requires live provider credentials; calculated from provider-reported token usage and documented rates | **NOT RUN**<br>*(Requires live API credentials)* |
| **#5** | Evaluation diversity across 4 mixed categories (50 queries each, held-out split) | `evals/suites/budget_eval_suite.ts` (`200` held-out queries: `50` factual, `50` math, `50` code, `50` extraction) | **NOT RUN**<br>*(Dataset implemented; requires live API credentials)* |
| **#6** | Negative-savings circuit breaker auto-trip to pass-through | `tests/circuit_breaker_e2e.test.ts`<br>Verified in CI: rolling net savings $\le 0$ trips breaker, subsequent requests run in pass-through mode, surfaces on CLI & dashboard | **PASS** |
| **#7** | Middleware decision overhead p95 $< 500\text{ms}$ | Measured via `performance.now()` excluding LLM I/O (`src/engines/budget.ts`, `src/engines/tool_dc.ts`) | **PASS** |
| **#8** | End-to-end runnable demonstration in `examples/` | `examples/agent_workflow_demo.ts`<br>Compiles cleanly; executes end-to-end when live provider credentials are configured | **PASS** |
| **#9** | Code quality: $\ge 80\%$ test coverage on engines, clean `tsc --strict` | `vitest run --coverage` + `npm run lint` + `npm run verify:dod` | **PASS** |

---

## Live Evaluation & Evidence Integrity Architecture

All benchmark execution is strictly live-only (`source: "live_provider"`). Missing, empty, or placeholder API keys fail immediately with an explicit error and never fall back to simulation.

Every generated benchmark report in `evals/results/<YYYY-MM-DD>_live_*.json` must include and pass validation in `evals/suites/benchmark_validator.ts`:
- `source`: `"live_provider"` (any `"unit_test"`, simulated, or unknown source is permanently rejected)
- `provider` & `model`: actual upstream provider (`"gemini" | "openai" | "anthropic"`) and exact model ID
- `credential_status`: `"live_credentials_present"` (no secrets exposed)
- `split`, `dataset_version`, & `dataset_hash`: SHA-256 hash of the evaluated query set
- `sample_size.valid_samples`: must be $> 0$
- `model_config`: active model routing & reasoning capabilities snapshot
- `token_usage`: actual provider-reported input, output, reasoning, and total tokens (`usage_source: "provider_reported"`; missing provider usage fails explicitly)
- `verifier_results`: passed, failed, and errored verification counts (`errored === 0` required)
- `accuracy_metrics`: explicit baseline and AEL accuracy against configured absolute quality floors (zero-on-both-sides cannot pass)
- `cost_methodology`: distinguishes rates-based calculation from provider-billed invoice totals and excludes verifier/judge costs from product savings
- `timestamp`: ISO-8601 evaluation timestamp
- `savings_claims_valid`: failed evaluations suppress headline net token/USD savings claims (`null`)

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
AEL classifies decision evidence into six distinct, non-equivalent signals:
1. `externally_verified`: Deterministic non-LLM check (programmatic JSON schema validation, dry-run sandbox outcome, or deterministic tool validation). Never emitted for LLM-only judgments.
2. `model_confidence`: Reserved strictly for provider-reported logprobs or token confidence metrics exceeding `evidence_confidence_threshold` (`confidence_source: provider_logprobs`). Never emitted by an LLM judge.
3. `llm_judge_verdict`: Output evaluated and resolved by an explicit LLM-Judge escalation/verification step (`BudgetEngine` escalation path). Distinct from both deterministic external verification and provider logprob metrics.
4. `consensus`: Empirical agreement across $k \ge 2$ sampled completions in `sample` mode (never emitted in `single` mode without multi-sample voting).
5. `insufficient_evidence`: Complexity heuristic or low sample agreement triggered escalation, or request ran in pass-through / policy-halt mode.
6. `unavailable`: Single-probe completion where the provider supplied no `logprob_confidence` and no multi-sample consensus or LLM-judge step ran.

> [!WARNING]
> **Methodological Note on Consensus**: Self-consistency across $k$ samples is recorded strictly as an empirical stopping heuristic, **NOT** mathematical proof of correctness.

### 3. Negative-Savings Circuit Breaker
Per workflow, AEL maintains a rolling window of 20 requests. If rolling net savings (on comparative runs) fall $\le \$0.00$ or error rate exceeds threshold, AEL automatically trips that workflow to pass-through mode, logs a warning, and surfaces it on the dashboard and CLI.

### 4. Actual-Only Live Accounting vs. Comparative Benchmark Claims
- **Live Per-Request Accounting (`actual_only`)**: Live proxy endpoints (`POST /v1/chat/completions`, `POST /v1/messages`) and `BudgetEngine.routeAndExecute()` (without a comparative benchmark baseline) report **actual consumption only** (`actual_tokens`, `upstream_tokens`, `ael_internal_tokens`, `actual_cost_usd`, `ael_overhead_ms`). AEL never executes hidden counterfactual calls or claims per-request savings on live traffic.
- **Comparative Benchmark Savings (`comparative_benchmark_identical_samples`)**: All token and USD savings claims come exclusively from the separate comparative benchmark (`eval --suite budget`), which evaluates fixed `high`-effort baseline and AEL side-by-side on identical samples against a real live provider.

### 5. Code Verifier Scope (Child Process + Sanitized Env — Not a Security Sandbox)
- The `code_execution` benchmark verifier (`evals/suites/budget_verifiers.ts`) compiles snippets with `esbuild` and executes assertions inside a **separate Node.js child process** with an empty/sanitized environment (`env: {}` — zero inherited API keys or secrets), a clean `node:vm` context, and hard timeouts (inner VM CPU timeout + outer `SIGKILL` timeout).
- **Honest Isolation Boundary**: Child-process execution + `env: {}` isolates parent memory and environment secrets/API keys, **but runs under the same OS user/UID with shared host filesystem/kernel permissions**. It is **NOT** a container, seccomp jail, or microVM security sandbox; adversarial untrusted code must still be isolated in an OS container or microVM outside this benchmark harness.

---

## Quickstart

### 1. Installation
```bash
git clone https://github.com/benghaouti81/AEL-Agent-Economics-Layer-.git
cd AEL-Agent-Economics-Layer-
npm install
```

### 2. Running Unit Tests, Verification Gate, and Live Evaluations
```bash
# Run unit & engine tests with V8 coverage report
npm run test:coverage

# Verify code integrity & DoD compliance (no mock paths, coverage >= 80% on engines)
npm run verify:dod

# Run live evaluation suites against a configured provider (requires GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY)
GEMINI_API_KEY=your_real_key npx tsx bin/ael.ts eval --suite all --split held_out --limit 5 --model gemini-2.5-flash-lite

# Print executive economic report from SQLite decision log
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
- Confidence taxonomy distribution
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
