# AISH — Requirements Skeleton (evidence-driven)

AISH is a future execution environment for coding agents — an AI-native shell with
repository-aware, token-efficient tools. This document is a **skeleton**: it lists candidate
capabilities, but deliberately leaves the numbers blank. Per the project vision, **no AISH
capability ships because it "sounds like a good idea"** — each must be justified by a
profiler measurement and given a target to beat.

> Profiler → evidence. AISH → optimisation. Every optimisation traces back to a metric here.

## How to use this document

For each capability, fill the four slots as benchmark data arrives:

- **Hypothesis** — the inefficiency we believe exists and the capability that addresses it.
- **Profiler metric** — the _specific_ measurement that proves the problem, and the exact
  `aap` command / field that produces it. If we can't measure it, we don't build it yet.
- **Baseline** — the measured number today (opencode/DeepSeek, Claude Code), from the
  benchmark suite (`benchmarks/`). _Leave as `TBD` until measured._
- **Target** — the measurable goal AISH must hit to justify the capability. _Set once the
  baseline is known (e.g. "−70% vs baseline")._

A capability with no baseline is a hypothesis, not a requirement. Promote it only when the
baseline shows the problem is real and material.

> **Status of the metrics:** every **Profiler metric** referenced below is _already
> implemented_ in the profiler today (capture → `aap parse` → API/`aap compare`/recommendations).
> The only exceptions are listed under [Open metrics](#open-metrics-not-yet-built-in-the-profiler).
> So filling the baselines requires **only running the benchmark suite** — no further profiler
> work is needed first.

### Template

```
### N. <capability>
- Hypothesis: <what's wasteful now / what AISH does instead>
- Profiler metric: <metric> — via `<aap command / field>`
- Baseline: TBD  (opencode/DeepSeek: __, Claude Code: __)
- Target: TBD
- Design sketch: <one or two lines>
- Risk / notes: <caveats>
```

---

## Candidate capabilities

At a glance — each capability and the already-implemented metric that justifies it:

| #   | Capability                     | Justifying profiler metric (available today)           |
| --- | ------------------------------ | ------------------------------------------------------ |
| 1   | Ranged / structured reads      | read-tool result tokens (amplification)                |
| 2   | Repo-aware symbol search       | search-tool result tokens (`top_tools`, `aap compare`) |
| 3   | Result summarisation           | `high_amplification` recommendation                    |
| 4   | Observation / read caching     | `repeated_file_read` recommendation                    |
| 5   | Lean tool definitions          | `context_duplication` (`metrics.tools_tokens`)         |
| 6   | Context compaction             | context-growth series (`analysis.growth`)              |
| 7   | Structured (typed) tool output | bytes-per-token (`result_bytes` / `result_tokens`)     |
| 8   | Fewer round-trips              | requests per task (`stats.requests`, `aap compare`)    |
| 9   | AISH shell (replaces `bash`)   | command usage/frequency/category (`aap commands`)      |
| 10  | Locate-and-read (path-miss)    | search→read pattern (`inefficient_search` rec)         |

### 1. Ranged / structured file reads

- Hypothesis: agents read whole files when they need a few symbols or lines, inflating
  context. AISH offers range/symbol reads (`read(file, symbol|lines)`) returning only what's
  needed.
- Profiler metric: tool-result **token amplification** for read-like tools — sum of
  `tool_calls.result_tokens` for `read`/`view`; via `aap compare --task explain` and the
  `high_amplification` recommendation.
- Baseline: TBD (opencode/DeepSeek: __, Claude Code: __)
- Target: TBD
- Design sketch: symbol-aware read backed by an index (see #2); default to a bounded window.
- Risk / notes: partial reads can hide needed context → more follow-up reads; measure net
  tokens across the task, not per call.

### 2. Repository-aware code search (symbol index)

- Hypothesis: agents lean on `grep`/`cat`/directory listings whose text output is
  token-expensive and noisy. A symbol/reference index returns precise, compact hits.
- Profiler metric: result tokens + call count for search/list tools (`grep`, `find`, `ls`,
  `bash`) — via `top_tools` (result tokens per tool) and `aap compare --task locate`.
- Baseline: TBD
- Target: TBD
- Design sketch: prebuilt symbol/reference index; `find_def` / `find_refs` returning
  `file:line` + minimal snippet instead of raw grep dumps.
- Risk / notes: index staleness; must handle non-code files.

### 3. Tool-result summarisation & truncation

- Hypothesis: large command outputs (build logs, big files, `ls -R`) dump thousands of
  tokens into context, most unused. AISH summarises/truncates with an opt-in "expand".
- Profiler metric: **token amplification** distribution — `tool_calls.result_tokens`
  (per call and per tool); the `high_amplification` recommendation flags the worst offenders.
- Baseline: TBD
- Target: TBD
- Design sketch: cap tool output at N tokens with a structured head/tail + a handle to fetch
  more; summarise logs.
- Risk / notes: truncation can drop the one line that mattered — measure task success, not
  just token reduction.

### 4. Observation caching / read de-duplication

- Hypothesis: agents re-read the same file / re-run the same command many times within a
  session, re-paying the token cost each time. AISH caches unchanged observations.
- Profiler metric: **repeated tool calls by argument** — the `repeated_file_read` /
  `repeated_tool_call` recommendations; `analysis.repeated` count × result tokens.
- Baseline: TBD
- Target: TBD
- Design sketch: content-addressed cache keyed by (tool, args, file-mtime); return "unchanged
  since last read" instead of re-emitting.
- Risk / notes: cache invalidation on file edits; correctness over savings.

### 5. Lean, on-demand tool definitions

- Hypothesis: full tool schemas are re-sent on every request, a large static overhead that
  scales with session length. AISH sends compact defs and/or loads tools on demand.
- Profiler metric: **context duplication** — `metrics.tools_tokens` per request × request
  count (session "Context cost"); the `context_duplication` recommendation. The profiler also
  captures **prompt-cache hit tokens** (`metrics.cached_input_tokens`, per-session hit ratio),
  and `context_duplication` is **cache-aware** — it downgrades when the static prefix is
  largely served from provider cache, so the metric reflects real cost, not just raw tokens.
- Baseline: TBD
- Target: TBD
- Design sketch: minimal schemas; progressive disclosure / tool namespaces loaded when
  relevant; rely on provider prompt caching where available.
- Risk / notes: fewer advertised tools can reduce capability discovery.

### 6. Context compaction / pruning of stale observations

- Hypothesis: input tokens grow steeply over a session as old tool results linger unused,
  raising cost on every subsequent turn. AISH prunes/compacts superseded observations.
- Profiler metric: **context growth** series — `analysis.growth` (input tokens across
  requests); the `context_growth` recommendation; first vs last input tokens.
- Baseline: TBD
- Target: TBD
- Design sketch: drop or summarise tool results the model no longer references; keep a
  retrievable archive.
- Risk / notes: needs "was this observation actually used later?" signal (not yet measured —
  see Open metrics).

### 7. Structured (typed) tool output instead of text dumps

- Hypothesis: free-text tool output is token-inefficient vs a compact structured form the
  model can consume directly. AISH returns typed, minimal payloads.
- Profiler metric: **bytes-per-token efficiency** and result tokens — `tool_calls.result_bytes`
  vs `result_tokens`; compare a structured tool vs its text equivalent via `aap compare`.
- Baseline: TBD
- Target: TBD
- Design sketch: schema'd results (paths, ranges, counts) rather than rendered tables/prose.
- Risk / notes: some models handle prose better than JSON — verify comprehension, not just size.

### 8. Fewer round-trips (batched operations)

- Hypothesis: agents make many small requests/tool calls that could be batched, each paying
  fixed per-request overhead (system prompt + tool defs).
- Profiler metric: **requests per task** and per-request static overhead — `stats.requests`,
  session request count; `aap compare` request counts across agents.
- Baseline: TBD
- Target: TBD
- Design sketch: batch tool APIs (read many files / multi-edit in one call).
- Risk / notes: batching can hurt if it over-fetches; measure net tokens.

### 9. AISH shell (replacing the generic `bash` tool)

- Hypothesis: the agent is given one `bash` tool and drives everything through free-form
  shell commands. Because it draws on pretraining, it reaches for verbose, token-expensive
  programs (`ls -al`, `cat`, `grep -r`, `find`) and their raw text output floods context.
  A purpose-built shell exposing lean, structured, repo-aware verbs would cut that waste.
- Profiler metric: **which shell programs are actually used, how often, and for what** —
  `aap commands` (per-command count + result tokens, now with a `category`: search / read /
  vcs / build / nav / other), scoped per session. This shows whether the agent uses a small
  subset of `bash` (and therefore how small AISH's verb set can be).
- Baseline: TBD (opencode/DeepSeek: __, Claude Code: __)
- Target: TBD
- Design sketch: replace `bash` with `aish`, an AI-native shell whose verbs map to #1–#7
  (ranged reads, symbol search, structured output, caching). See adoption note below.
- Risk / notes — **the pretraining problem:** the model has never seen `aish`, so it will not
  spontaneously use its verbs the way it uses `ls`/`cat`/`git`. Candidate approaches to
  evaluate (each measurable): (a) keep the tool accepting ordinary shell-command **strings**
  so the model still "thinks in bash", while AISH intercepts/optimises behind the scenes —
  favours the **proxy `--optimize`** placement; (b) expose explicit typed verbs with a rich
  description + few-shot examples in the tool schema and measure adoption rate; (c) hybrid:
  accept shell strings but progressively steer toward verbs. Adoption itself becomes a metric.

### 10. Locate-and-read (path-miss auto-search)

- Hypothesis: when the human names a file without a full path, the agent burns a
  search→read round-trip chain — e.g. `ls -alR` / `find` / `grep` to locate the file, then a
  separate `read`. A `read(name)` that auto-searches on a path miss and returns the best match
  folds those calls into one.
- Profiler metric: **search→read pattern** — locate-type shell commands
  (`find`/`ls`/`grep`/`rg`, the `search` category from #9) occurring alongside file reads;
  surfaced by the new `inefficient_search` recommendation and `aap commands` category counts.
- Baseline: TBD
- Target: TBD
- Design sketch: `read` accepts a bare filename; on miss, run an indexed search (see #2) and
  return the unique match's content (or a compact candidate list if ambiguous).
- Risk / notes: ambiguous names → wrong file; must return candidates instead of guessing.
  Measure net round-trips and tokens across the locate+read episode, not per call.

---

## Where does an optimisation run? Three delivery vehicles

The original vision framed AISH as a shell replacement. After reflection, three progressively
riskier delivery vehicles are worth considering — ordered by adoption friction:

### Vehicle A: `aap serve --optimize` (proxy-level rewriting)

**Friction:** zero — the agent doesn't know it's being optimized. The proxy already sits in
the right position. Apply transformations to requests/responses without agent cooperation.

**What fits here:** capabilities that rewrite the wire without changing tool semantics:
- **Truncate/summarise large tool results** (#3) — cap at N tokens, append a handle
- **De-duplicate repeated observations** (#4) — return "unchanged since turn 7" stub
- **Prune stale context** (#6) — rewrite request messages to drop tool results the model
  hasn't referenced in K turns
- **Stabilise prefix for prompt caching** (#5) — reorder/canonicalise tool definitions so
  the byte prefix stays stable across requests

**Hard constraint:** this mode is **explicit, off-by-default**. The profiler's default is
transparent read-only. Optimizations must not regress task success. Each must be toggled
individually (e.g. `--optimize=truncate,dedup`) so we can measure contribution.

### Vehicle B: AISH-as-MCP-server

**Friction:** low — the agent gains new tools alongside its existing ones (bash, read, etc).
No shell replacement, no special integration. Just register additional MCP tools that happen
to be smarter.

**What fits here:** capabilities that offer better _alternatives_ the agent can choose:
- Ranged/symbol reads (#1, #2) — `aish_read(file, symbol)`, `aish_find_def(name)`
- Locate-and-read (#10) — `aish_open(name)` that auto-resolves path
- Structured output tools (#7) — alternatives to `ls`/`grep` returning JSON

The profiler data tells you which tools to build: the `top_tools` and `aap commands`
breakdown shows which bash verbs are most called and most expensive. Build MCP replacements
for the top 3-5 and measure adoption + token savings.

### Vehicle C: AISH-as-shell (full replacement)

**Friction:** high — requires forking agent config, replacing the bash tool, likely
fine-tuning or heavy system-prompt engineering for adoption.

**What fits here:** the full vision from capabilities #8 and #9. Only worth pursuing if
Vehicle A + B have proven the individual optimizations work and the remaining gap is "the
agent still reaches for bash out of habit."

### Recommended path

```
Vehicle A (--optimize)  →  measure  →  Vehicle B (MCP tools)  →  measure  →  Vehicle C (if needed)
```

Start with `--optimize` because:
1. Zero adoption friction — works with any agent today
2. The proxy already has the data to decide when to optimise (it sees repeated reads, growing context, large results)
3. Each optimization is independently measurable via `aap compare` (optimized vs baseline)
4. If the proxy-level optimizations get 60%+ of the theoretical savings, the case for a full shell replacement weakens — which is useful information

---

## `aap serve --optimize` — Design

### Detection → Action model

The proxy already captures enough signal to detect optimizable patterns in real-time (not
post-hoc). Each optimization is a detector + an action:

| Optimization | Detector (real-time signal) | Action (response rewriting) | Expected savings |
|---|---|---|---|
| **Truncate large results** | `response_body` byte count exceeds threshold (e.g. >8KB) | Truncate to head+tail with `[...N lines omitted, use expand(handle) for full]` | 50-80% of result tokens for big outputs |
| **Dedup repeated reads** | Same (tool_name, arguments) seen earlier in session with same file mtime | Replace result with `[unchanged since turn K — N tokens omitted]` | 100% of duplicate result tokens |
| **Prune stale context** | Request body messages: tool_result older than K turns, never referenced in subsequent assistant messages | Remove content, replace with `[pruned — available via recall(id)]` | Compound: reduces input_tokens growth |
| **Stable tool prefix** | Detect tool definitions changed order/whitespace between requests | Canonicalise tool JSON for byte-stable prefix | Improves cache hit rate (measured via cached_input_tokens) |

### Architecture

```
request  →  [detect patterns in request body]  →  [rewrite if applicable]  →  upstream
response ←  [detect patterns in response]      ←  [rewrite if applicable]  ←  upstream
```

The `--optimize` flag activates an `OptimizeLayer` that wraps the normal `forward()`:
- It maintains per-session state (seen tool calls, turn counter, message hashes)
- On request: can rewrite message bodies (prune stale context)
- On response: can rewrite tool results (truncate, dedup)
- Every rewriting is logged as a trace event (`type: "optimize"`) so the profiler itself can
  measure what it did and correlate with outcomes

### Metrics for success

Each optimization's value is measured by comparing sessions with vs without it:
- `aap compare <optimized_session> <baseline_session>` → shows delta in tokens, cost, requests
- A new `optimize_actions` table records what the optimizer did (type, tokens_saved, turn)
- The `recommend` engine gains a new rec kind: `optimization_opportunity` — fires in
  non-optimized sessions to show "this session would have saved X tokens with --optimize"

---

## Detecting optimizable patterns — Easy targets with big benefits

Based on the profiler's existing data model, these are the highest-value patterns to detect,
ordered by expected ROI:

### 1. Repeated file reads (BIGGEST WIN)

**Signal:** Same `(tool_name, arguments)` where tool is read-like, appearing 3+ times.
**Already detected:** `repeated_file_read` recommendation.
**Why it's big:** In real sessions, agents re-read the same file 5-10x as context grows and
the model "forgets" it already has the content. Each re-read pays full token cost.
**Optimization:** On the Nth read of the same file (N≥2), if mtime unchanged, return a
compact stub: `[file unchanged — content identical to turn K, ~N tokens]`.
**Estimated savings:** 30-50% of total read-tool result tokens (the single largest category
in most sessions).

### 2. Large tool results (EASY WIN)

**Signal:** `tool_calls.result_tokens > threshold` (e.g. >2000 tokens for a single call).
**Already detected:** `high_amplification` recommendation.
**Why it's big:** One `cat` of a large file or `ls -R` of a deep tree can inject 10K+ tokens.
The agent usually only needs a fraction.
**Optimization:** Truncate to first 50 + last 20 lines with a summary line:
`[showing 70 of 847 lines — use expand(handle) for specific ranges]`.
**Estimated savings:** 50-80% of individual large results. Conservative 20-30% of total
session result tokens (large results are few but dominate by volume).

### 3. Context growth from stale tool results (COMPOUND WIN)

**Signal:** `analysis.growth` shows input_tokens growing >3x over a session. The growth
is driven by the message history accumulating old tool results that are never referenced
again.
**Already detected:** `context_growth` recommendation.
**Why it's big:** In a 30-request session, if input tokens grow from 5K to 80K, the agent
is paying for 75K tokens of accumulated history on every turn. Most of that is stale tool
results from turns 1-10.
**Optimization:** On request rewrite: identify tool_result messages older than K turns that
were not referenced (substring match) in any subsequent assistant message. Replace content
with a stub. This is the riskiest optimization (could prune something needed) but also the
highest-value for long sessions.
**Estimated savings:** 40-60% of input token growth in sessions >20 requests.

### 4. Unstable tool definition prefix (FREE WIN)

**Signal:** `metrics.cached_input_tokens` is low relative to `metrics.input_tokens` AND
tool definitions are present. The system prompt + tools form a prefix that should be
byte-stable for provider caching — but agents sometimes vary whitespace, key order, or
tool ordering between requests.
**Already detected:** Partially via `context_duplication` rec + cache hit ratio.
**Why it's big:** Anthropic charges 90% less for cached input tokens. If the first 20K
tokens (system + tools) cache-hit on every request, a 30-request session saves ~540K tokens
worth of cost. But if the prefix varies by even one byte, the cache misses.
**Optimization:** Canonicalise tool definitions (sort keys, stable JSON serialization) on
request rewrite. Zero risk — semantically identical.
**Estimated savings:** Depends on current cache hit rate. If going from 30% → 90% hit on a
20K-token prefix across 30 requests: saves ~$0.30-1.00 per session at Anthropic rates.

### 5. Search→read round-trip chains (MODERATE WIN)

**Signal:** A search-category shell command (`find`, `grep`, `rg`, `ls`) followed within
2 turns by a read of a file that appeared in the search output.
**Already detected:** `inefficient_search` recommendation.
**Why it's big:** Each round-trip costs a full request (re-sending system + tools + history).
3 search→read chains = 3 extra requests × full context.
**Optimization:** This one is better served by Vehicle B (an MCP tool that combines search +
read). At the proxy level, the best we can do is surface the pattern aggressively in
recommendations so users know to add better tools to their agent.
**Estimated savings:** 2-3 fewer requests per task × per-request overhead.

### Priority order for implementation

1. **Repeated reads** — highest confidence, already detected, simple to implement
2. **Truncate large results** — simple heuristic, big per-occurrence savings
3. **Stable prefix** — zero risk, pure cost optimization, no semantic changes
4. **Stale context pruning** — highest total savings but riskiest, needs careful measurement
5. **Search→read** — better addressed via MCP tools (Vehicle B)

---

## Measurement protocol

Baselines come from the benchmark suite in [`benchmarks/`](../benchmarks/README.md):

1. `aap serve`, then `./benchmarks/run.sh opencode` (and `claude` when available).
2. `aap parse`, then collect the numbers with `node benchmarks/baselines.mjs`, which writes
   [`benchmarks/BASELINES.md`](../benchmarks/BASELINES.md) — per task, the mean of each metric
   across runs, grouped by agent, counting only `verify=pass` runs for mutating tasks.
3. Copy the relevant figure from that report into the `Baseline:` slot of each capability
   above (the metric→capability hints are noted in `benchmarks/baselines.mjs`).
4. Once AISH exists, add it as a third column; a capability is justified only if AISH beats
   the baseline on its stated metric **without** regressing task success.

## Open metrics (not yet built in the profiler)

Some capabilities above need signals the profiler does not yet produce. Build these in the
profiler first if the corresponding capability becomes a priority:

- **"Observation used vs ignored"** — did the model reference a tool result in later output?
  (needed for #3, #6). Speculative; requires response↔prior-result text analysis.
- **Local tool latency** — deliberately not built: the off-wire signal is too noisy to be
  trustworthy (see conversation notes). Provider round-trip latency (`requests.latency_ms`)
  is measured and reliable.

## Non-goals (inherited from the vision)

- AISH is not an assistant; the profiler in **default mode** is not an optimiser (read-only).
- `--optimize` mode is the explicit opt-in for wire rewriting — never implicit.
- No optimisation ships without a profiler metric justifying it and a target to beat.
- No optimisation that improves a metric while regressing task success.
