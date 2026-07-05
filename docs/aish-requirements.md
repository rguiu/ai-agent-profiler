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

## Where does an optimisation run? AISH vs proxy `--optimize`

Some capabilities here are **tool design** (belong in AISH) and some are **request/response
rewriting** (could be enforced by the profiler proxy). This boundary is deliberately left
open until measured; each capability above carries a hint, but the rule of thumb:

- **AISH** — anything that requires new tool _semantics_ the agent invokes deliberately:
  ranged/symbol reads (#1, #2), typed output (#7), batched verbs (#8), the shell itself (#9),
  locate-and-read (#10).
- **Proxy `--optimize` (candidate, not built)** — anything that rewrites the wire without the
  agent's cooperation: summarising/truncating tool results (#3), de-duplicating repeated
  observations (#4), pruning stale context with a stub notice (#6). These can be applied to an
  _existing_ agent (no AISH required), which makes them attractive to prototype in the proxy.

**Hard constraint:** the profiler's default mode is transparent and **read-only** (VISION.md —
"never changes requests"). Any wire-rewriting therefore may only exist as an **explicit,
off-by-default `--optimize` mode**, and — like every AISH capability — must be justified by a
baseline metric and must not regress task success. It is **not** built today; it is recorded
here so the AISH-vs-proxy decision is made on evidence rather than by default.

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

- AISH is not an assistant; the profiler is not an optimiser.
- No AISH capability without a profiler metric justifying it and a target to beat.
- No capability that improves a metric while regressing task success.
