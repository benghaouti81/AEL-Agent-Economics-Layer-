# AEL — Architecture Decisions Record (DECISIONS.md)

This document records the architectural and system engineering decisions made in AEL (Agent Economics Layer) v0.1.0.

---

## ADR-001: Runtime & Implementation Language
- **Decision**: Full-stack TypeScript (strict mode) running on Node.js 22 LTS with Express for HTTP proxy endpoints and Vite for dashboard asset bundling.
- **Rationale**: Agents and MCP ecosystems (Claude Code, Cursor, Model Context Protocol) have first-class TypeScript SDKs. Unifying the proxy, MCP gateway, and web dashboard into a single Node.js runtime simplifies deployment to a single container without multi-language IPC overhead.
- **Alternatives Considered**: Python with FastAPI. Rejected to avoid split-runtime friction with the official `@modelcontextprotocol/sdk` and to enable unified bundling with Vite/React.

---

## ADR-002: Decision Log Engine — `better-sqlite3`
- **Decision**: Use `better-sqlite3` with WAL mode for the Decision Log (`LogStore`).
- **Rationale**: AEL is designed for self-hosted, edge, and developer-local deployment. `better-sqlite3` provides ultra-fast synchronous execution (sub-millisecond latency overhead), zero network hops, zero external database setup, and ACID safety.
- **Alternatives Considered**: PostgreSQL, DuckDB, Redis. PostgreSQL requires external daemon infrastructure; DuckDB is optimized for columnar OLAP batches rather than transactional per-request writes.

---

## ADR-003: Author-Declared Tool Execution Contracts (No LLM Inference)
- **Decision**: Execution contracts (`dry_run_support`, `side_effect`, `reversible`, `requires_human_approval`, `idempotency_key`) must be author-declared or statically configured. They are NEVER inferred by an LLM at runtime.
- **Rationale**: Research demonstrates that agents hallucinate safety boundaries and policy compliance under prompt injection or ambiguous phrasing. Author-declared contracts guarantee deterministic sandbox enforcement: mutating tools are strictly barred from dry-run execution, and destructive tools require explicit human approval flags independently of successful argument validation.

---

## ADR-004: 4-Level Confidence Signal Taxonomy
- **Decision**: Decision records and telemetry distinguish four explicit confidence tiers:
  1. `externally_verified`: Deterministic check, programmatic test, or dry-run validation.
  2. `model_confidence`: Logprob confidence or token-level provider metrics.
  3. `consensus`: Agreement across $k$ samples (self-consistency).
  4. `insufficient_evidence`: Escalation trigger or early halt.
- **Rationale**: Prevents conflating consensus heuristics with ground-truth verification. Self-consistency across $k$ samples indicates empirical stability, not mathematical correctness.

---

## ADR-005: Net Savings Accounting with Internal Overhead Tracking
- **Decision**: Every decision record calculates Net Savings:
  $$\text{Net Savings} = \text{Baseline Cost} - (\text{Upstream Cost} + \text{AEL Internal Overhead})$$
  Both tokens and USD are tracked for internal AEL compute (selection batches, judges, verifiers).
- **Rationale**: Economic middleware must never claim gross savings while hiding internal token consumption. Reporting net savings and the headline KPI "USD per successful completed task" guarantees complete economic transparency.

---

## ADR-006: Negative-Savings Circuit Breaker
- **Decision**: Maintain a rolling window of 20 requests per workflow. If net savings $\le 0$ or error rate exceeds threshold, automatically trip the workflow to pass-through mode and emit warnings.
- **Rationale**: Ensures AEL never silently loses money on workflows where adaptive compute fails to produce positive returns.

---

## ADR-007: Frozen Read-Only Dashboard Scope
- **Decision**: The React dashboard at `/dashboard` is strictly frozen as a single read-only view fed exclusively by `GET /api/metrics/summary` and `GET /api/metrics/decisions`.
- **Rationale**: Prevents scope creep. The CLI (`ael report`, `ael eval`) is the primary reporting engine; the dashboard is a convenient executive receipt demonstrating economic value.

---

## ADR-008: 200 Distinct Held-Out Benchmark Dataset Composition
- **Decision**: The Thinking Budget evaluation suite (`evals/suites/budget_eval_suite.ts`) specifies 200 completely unique, handcrafted high-difficulty queries (50 per category across factual, math, code, and extraction), prohibiting modulo cycling (`i % pool.length`) or artificial prompt padding (`[Item #N]`).
- **Rationale**: Real benchmark integrity requires genuine prompt diversity across algorithmic complexity, linguistic phrasing, and technical domains. Repetitive template cycling artificially skews cache dynamics and token lengths.

---

## ADR-009: Deterministic CI Execution via `package-lock.json`
- **Decision**: Commit a clean, audited `package-lock.json` and align `esbuild` peer dependency ranges with Vite 8.x to ensure `npm ci` executes deterministically in GitHub Actions workflows without build or resolution failures.
- **Rationale**: GitHub Actions runners executing `actions/setup-node@v4` with `cache: 'npm'` and `npm ci` strictly mandate an authoritative, lockfile-backed dependency graph.
