# Introducing AEL: The Agent Economics Layer

### Why AI Agents Burn Cash and Break Policies — And How We Solved It

Over the last twelve months, AI agent architectures have rapidly matured from toy scripts to multi-step enterprise workflows. Yet as soon as developers connect their agents to real tools (MCP servers) and frontier reasoning models, they hit two brutal economic realities:

1. **The Tool Bloat Tax & Knowing-vs-Doing Gap**: When an agent needs access to dozens or hundreds of tools, developers typically dump all tool schemas into the model’s context window. This burns thousands of input tokens per step, degrades reasoning, and causes hallucinated calls. Worse, 2026 benchmarks (such as the R2A-Sales evaluation) revealed that while agents recite tool policies correctly ~89.9% of the time, they adhere to them in practice as low as 17.3% of the time. Knowing a policy is not adhering to it.
2. **The Uniform Reasoning Trap**: Frontier reasoning models are remarkably capable, but applying a uniform high reasoning budget to every request is pure economic waste. A straightforward factual query does not deserve 800 reasoning tokens, while a complex multi-step constraint problem will fail without them.

Existing tools fail to address this intersection. Model routers choose *which model* answers, but they don't decide *how much inference compute* a model should expend or *which specific tool* it should invoke. Meanwhile, MCP gateways simply enumerate raw tool schemas without verifying safety contracts or validating arguments before execution.

Today, we are open-sourcing **AEL (Agent Economics Layer)** v0.1.0: a self-hosted middleware in TypeScript that sits between your agent framework (LangChain, LlamaIndex, Claude Code, Cursor) and your upstream resources (LLM APIs + MCP tool servers), making two economic decisions on every single request.

---

## 1. Tool Selection with Training-Free "Try-Check-Retry" (Tool-DC)

Instead of overwhelming the LLM with an entire catalog of tool schemas, AEL implements the **Tool-DC** framework (arXiv:2603.11495):

- **Divide**: AEL indexes tool metadata and semantically retrieves a small, focused batch of candidate tools (typically 3–4) relevant to the immediate user prompt.
- **Try**: The model proposes a tool and exact JSON arguments from the focused batch.
- **Check**: AEL validates the proposal against strict JSON schema definitions and, for tools classified as safe or idempotent, executes a non-mutating **dry-run** in a local sandbox to verify arguments and return types before any live execution occurs.
- **Retry**: If schema validation fails, or if the dry-run errors out, AEL captures the exact error, passes it back to the model as reflection feedback, narrows the candidate batch, and retries (up to 3 attempts).

Crucially, AEL enforces **author-declared execution contracts** (`dry_run_support`, `side_effect`, `reversible`, `requires_human_approval`). Mutating tools are strictly barred from dry-run execution, and destructive tools require explicit human authorization flags independently of validation checks.

In our evaluation harness (`evals/results/2026-11-10_tool_selection.json`), Tool-DC achieved **90.0% tool-selection accuracy** with **3 demonstrated dry-run catches** of faulty parameters and unauthorized operations before side effects occurred.

---

## 2. Thinking Budget with Adaptive Compute (AERA & CoBa)

To eliminate wasted reasoning tokens, AEL applies **AERA (Adaptive Evidence Residual Allocation, arXiv:2608.27964)** and **CoBa (Compute-Balanced Routing, arXiv:2608.07424)**:

1. **Cheap First Probe**: AEL runs the incoming query at minimal inference compute (zero or low reasoning effort).
2. **Evidence Residual Check**: The engine evaluates stability through a strict 4-level confidence taxonomy: `externally_verified`, `model_confidence`, `consensus` (across $k$ cheap samples), or `insufficient_evidence`.
3. **Escalate or Stop**: If the cheap probe provides sufficient evidence, AEL stops immediately and returns the result. If evidence is unstable or the query is genuinely complex, AEL allocates inference compute to a verifier step or escalates up the reasoning ladder.
4. **Negative-Savings Circuit Breaker**: To guarantee that AEL never costs more than it saves, a rolling 20-request window monitors net savings per workflow. If net savings ever fall below zero, the workflow automatically trips to pass-through mode.

---

## 3. Evaluation Diversity & Measurable Accounting

AEL ships with a unified, file-backed **SQLite Decision Log (`better-sqlite3`)** that accounts for every token and dollar spent—including AEL’s own internal prompt overhead:

$$\text{Net Savings} = \text{Baseline Cost} - (\text{Upstream Cost} + \text{AEL Internal Cost})$$

Our evaluation harness features an expanded **200-query held-out benchmark split** (50 queries each across factual lookup, multi-step math/logic, code synthesis, and structured data extraction) spanning simple to expert-level constraints. In local plumbing execution (`evals/results/2026-11-10_budget_held_out.json`):
- **69.2% token reduction** demonstrated vs. fixed-high-effort baselines.
- **p95 decision overhead of 8 ms**, far below the 500 ms contract cap.
- Direct drop in cost per completed task from $\$0.00056$ baseline to $\$0.00015$.

*(Note: Live model acceptance benchmarking requires provisioning provider API keys; offline execution is reported transparently as a control-flow plumbing validation).*

---

## Get Started in 60 Seconds

AEL runs as a standalone Node.js service exposing standard `/v1/chat/completions`, `/v1/messages`, and `/mcp/*` endpoints:

```bash
# Clone and install
git clone https://github.com/agent-economics-layer/ael.git
cd ael
npm install

# Run the evaluation benchmark suites
npx tsx bin/ael.ts eval --suite all

# Launch the middleware proxy and dashboard
npm run dev
```

Inspect your savings in real time via the frozen read-only dashboard at `http://localhost:3000/dashboard`, or generate an executive CLI summary anytime with `npx tsx bin/ael.ts report`.

AEL v0.1.0 is released under the **Apache-2.0 License**. Join us in stopping the agent token leak!
