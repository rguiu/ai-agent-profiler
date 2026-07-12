# AI Agent Profiler — Optimization Strategies Report

**Date:** July 2026  
**Branch:** `feat/deepseek-cache-optimize`  
**Target:** Claude Code via AWS Bedrock (eu-west-1)

---

## Table of Contents

1. [What is the AI Agent Profiler?](#what-is-the-ai-agent-profiler)
2. [How Claude Code Talks to the API](#how-claude-code-talks-to-the-api)
3. [How Anthropic's Cache Works](#how-anthropics-cache-works)
4. [The Optimization Layer — What It Does](#the-optimization-layer)
5. [Strategy Catalogue](#strategy-catalogue)
6. [Benchmark Results](#benchmark-results)
7. [Conclusions and Open Questions](#conclusions)
8. [DeepSeek Note](#deepseek-note)

---

## 1. What is the AI Agent Profiler? <a name="what-is-the-ai-agent-profiler"></a>

The AI Agent Profiler (`aap`) is a local HTTP proxy that sits between an AI coding agent (like Claude Code) and the model API (Anthropic, Bedrock, OpenAI, DeepSeek). It does two things:

1. **Captures** every request and response — storing them as NDJSON trace files for analysis
2. **Optimizes** (optional) — rewrites requests in flight to reduce token usage and cost

```
┌─────────────┐         ┌──────────────────────┐         ┌───────────────┐
│ Claude Code │ ──────▶ │  AI Agent Profiler   │ ──────▶ │  Bedrock API  │
│   (agent)   │ ◀────── │  (proxy on :8199)    │ ◀────── │  (upstream)   │
└─────────────┘         └──────────────────────┘         └───────────────┘
                              │
                              ▼
                        ┌──────────┐
                        │ SQLite + │
                        │  traces/ │
                        └──────────┘
```

### What it stores

For each session (one complete agent task), the profiler records:

- **Session metadata:** ID, client, working directory, start time
- **Per-request trace:** full request body, response body (streamed), status, latency
- **Derived metrics:** input/output tokens, cached tokens, cost, tool calls
- **Optimization actions:** which strategies fired, how many tokens saved

### How you use it

```bash
# Start the profiler proxy with optimization enabled
aap serve --optimize

# Run Claude Code through the proxy
aap run claude "Fix the bug in src/parser.js"

# After the task, see what happened
aap export <session-id>     # Full report
aap sessions                # List all sessions
aap optimize <session-id>   # Simulate optimizations on an existing session
```

**Zero configuration needed.** All 9 optimization strategies are enabled by default when you pass `--optimize`. The profiler auto-detects your provider (Anthropic/Bedrock vs OpenAI-compatible) and applies the right profile — no need to enable strategies individually or edit config files. Just `aap serve --optimize` and run your agent.

The web UI at `http://localhost:8199` shows sessions, requests, costs, and cache hit rates in real time.

---

## 2. How Claude Code Talks to the API <a name="how-claude-code-talks-to-the-api"></a>

### The Conversation Model

Claude Code uses the Messages API. Every time it needs the model to think or act, it sends the **entire conversation history** as a single HTTP request. The API is stateless — it has no memory between requests.

This means:

```
Request 1:  [system prompt] + [tools] + [user: "fix the bug"]
Request 2:  [system prompt] + [tools] + [user: "fix the bug"] + [assistant: "I'll read the file"] + [tool_use: Read] + [tool_result: file contents]
Request 3:  [system prompt] + [tools] + [all previous messages] + [assistant: "I see the issue"] + [tool_use: Edit] + [tool_result: "done"]
...
Request N:  [system prompt] + [tools] + [entire conversation up to this point]
```

**Every request re-sends everything from the beginning.** The conversation grows with every turn.

### Message Structure

A typical Claude Code request has this structure:

```json
{
  "model": "eu.anthropic.claude-opus-4-6-v1",
  "max_tokens": 16384,
  "system": [
    {"type": "text", "text": "You are Claude Code, Anthropic's CLI..."}
  ],
  "tools": [
    {"name": "Read", "description": "Reads a file...", "input_schema": {...}},
    {"name": "Write", "description": "Writes a file...", "input_schema": {...}},
    {"name": "Bash", "description": "Executes a command...", "input_schema": {...}},
    // ... 6-9 more tools
  ],
  "messages": [
    {"role": "user", "content": [
      {"type": "text", "text": "<system-reminder>Current date is 2026-07-11</system-reminder>"},
      {"type": "text", "text": "Fix the bug in src/parser.js"}
    ]},
    {"role": "assistant", "content": [
      {"type": "text", "text": "I'll read the file first."},
      {"type": "tool_use", "id": "toolu_abc123", "name": "Read", "input": {"file_path": "src/parser.js"}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "toolu_abc123", "content": "... 500 lines of file ..."}
    ]},
    // ... conversation continues
  ]
}
```

### Key Observations

| Part             | Size (typical)          | Changes between requests?       |
| ---------------- | ----------------------- | ------------------------------- |
| System prompt    | ~5,000 tokens           | Never (same every turn)         |
| Tool definitions | ~7,000 tokens           | Never (same every turn)         |
| Early messages   | Varies                  | Never (history is append-only)  |
| Recent messages  | Varies                  | Only the last one changes       |
| Tool results     | 100-10,000+ tokens each | Added each turn, never modified |

**The key insight:** Most of what's sent on each request is identical to the previous request. Only the newest message at the end is new. This is what makes caching so effective.

### Why Does the Conversation Grow?

In a typical 94-request coding session:

- System prompt: ~5K tokens × 94 requests = **470K tokens re-sent**
- Tool definitions: ~7K tokens × 94 requests = **658K tokens re-sent**
- Message history: grows from 0 to ~40K tokens over the session
- Cumulative input: **3.9 million tokens** (without optimization)

Without caching, this would cost approximately $19.6 on Opus 4.6 ($5/MTok base input). With caching, it costs ~$2. With optimization, it costs ~$0.48.

---

## 3. How Anthropic's Cache Works <a name="how-anthropics-cache-works"></a>

### Explicit Prompt Caching (Anthropic/Bedrock)

Anthropic uses an **explicit** caching model. The client tells the API where to cache by placing markers:

```json
{
  "type": "text",
  "text": "You are Claude Code...",
  "cache_control": { "type": "ephemeral" }
}
```

**Rules:**

- Maximum **4 markers** per request
- Content before a marker is cached for **5 minutes** after last use
- Minimum cacheable block: **1,024 tokens** (2,048 on some models)
- Cache match is **byte-exact** — any change invalidates everything after the change point

### Pricing (Bedrock, Opus 4.6)

| Token type              | Cost per million tokens | Relative    |
| ----------------------- | ----------------------- | ----------- |
| Cache write (5-minute)  | $6.25                   | 1.25× input |
| Cache read (subsequent) | $0.50                   | 0.10× input |
| Input (uncached)        | $5.00                   | 1.0×        |
| Output                  | $25.00                  | 5.0× input  |

> _Pricing verified against anthropic.com/pricing on 12 Jul 2026, model Opus 4.x. Rates change — re-verify before quoting._

**A cached token is 10× cheaper than an uncached token.** This is why cache hits matter enormously.

### How Claude Code Uses the Cache

Claude Code places exactly 4 markers per request:

```
┌──────────────────────────────────────────────────────────┐
│ system prompt   ←── marker 1 (end of system)             │
├──────────────────────────────────────────────────────────┤
│ tool definitions ←── marker 2 (end of tools)             │
├──────────────────────────────────────────────────────────┤
│ message 1 (user prompt)                                  │
│ message 2 (assistant reply)                              │
│ message 3 (tool results)  ←── marker 3 (context boundary)│
│ ...                                                      │
├──────────────────────────────────────────────────────────┤
│ latest message ←── marker 4 (latest user message)        │
└──────────────────────────────────────────────────────────┘
```

Because the conversation is append-only, everything above marker 3 is byte-identical across requests. The cache achieves **99-100% hit rate** by default.

### What Breaks the Cache

The cache invalidates when **any byte changes** before a marker. Things that can break it:

1. Modifying messages in the middle of the history (editing, pruning, reordering)
2. Changing system prompt content between turns
3. Adding/removing tool definitions
4. Re-ordering content within existing messages

Our optimization strategies must respect this: aggressive pruning saves tokens but can break the cache, costing more downstream.

---

## 4. The Optimization Layer — What It Does <a name="the-optimization-layer"></a>

When `aap serve --optimize` runs, every request passes through the OptimizeLayer before reaching the API. The layer applies multiple strategies in order:

```
Incoming request body (from Claude Code)
    │
    ▼
┌─ reorderVolatile ─────────────────────────────┐
│  Move changing <system-reminder> blocks       │
└───────────────────────────────────────────────┘
    │
    ▼
┌─ collapseSystem ──────────────────────────────┐
│  Replace repeated system prompt with hash     │
└───────────────────────────────────────────────┘
    │
    ▼
┌─ pruneUnusedTools ────────────────────────────┐
│  Remove tool definitions never used           │
└───────────────────────────────────────────────┘
    │
    ▼
┌─ stablePrefix ────────────────────────────────┐
│  Canonicalise tool JSON for byte-stability    │
└───────────────────────────────────────────────┘
    │
    ▼
┌─ pruneStale ──────────────────────────────────┐
│  Summarise old tool results                   │
└───────────────────────────────────────────────┘
    │
    ▼
┌─ insertBreakpoints ───────────────────────────┐
│  Restore/add cache_control markers            │
└───────────────────────────────────────────────┘
    │
    ▼
Optimized request → sent to Bedrock API
```

Additionally, tool results are intercepted on the response path for:

- **dedup:** Suppress identical repeat reads
- **truncate:** Trim oversized results (head+tail)
- **suppressReread:** Skip reading files just written

---

## 5. Strategy Catalogue <a name="strategy-catalogue"></a>

### Quick Reference

| Strategy            | Provider            | Impact                   | Status                      |
| ------------------- | ------------------- | ------------------------ | --------------------------- |
| `stripTools`        | All providers       | ~$0.45/session           | **Active** on Bedrock       |
| `tailTruncate`      | All providers       | ~$0.03/session           | **Active** on Bedrock       |
| `pruneStale`        | DeepSeek only       | Large (simulation)       | **DISABLED** on Bedrock — causes cache misses |
| `pruneUnusedTools`  | DeepSeek only       | Medium (simulation)      | **DISABLED** on Bedrock — changes prefix mid-session |
| `collapseSystem`    | DeepSeek only       | Medium (simulation)      | **DISABLED** on Bedrock — changes system bytes |
| `insertBreakpoints` | DeepSeek only       | Near-zero cache misses   | **DISABLED** on Bedrock — adds bytes to prefix |
| `dedup`             | Simulation only     | Small                    | Not called in live proxy    |
| `truncate`          | Simulation only     | Varies by file sizes     | Not called in live proxy    |
| `suppressReread`    | Simulation only     | Small                    | Not called in live proxy    |
| `stablePrefix`      | None (disabled)     | Cache-preservation only  | **DISABLED** on Bedrock — reorders bytes |
| `reorderVolatile`   | None (disabled)     | Cache-preservation only  | **DISABLED** on Bedrock — moves content |

**Disabled on Bedrock/Anthropic:** ALL prefix-editing strategies. The native cache achieves
98-99% read rate on unmodified requests. Any byte modification triggers cache writes at
12.5× the read cost. Only `stripTools` (from turn 1, stable prefix) and `tailTruncate`
(trailing edge, always a write) are safe.

**Disabled on DeepSeek:** Same set but for a different reason — automatic prefix caching
invalidates on any byte change. See `docs/DEEPSEEK-CACHING.md`.

### 5.1 collapseSystem — Collapse Repeated System Prompt

**What it does:** The system prompt (~5,000 tokens) is identical every request. After the first request, it replaces the full prompt with a short hash stub: `[system unchanged — hash:abc123]`.

**Savings:** ~6,900 tokens per request after the first. In a 94-request session: **~640K tokens total**.

**Cache impact:** Minimal. The system prompt is at the very start — collapsing it shortens the request but doesn't shift content positions of later messages.

**Risk:** The model may behave differently without its full system prompt. In benchmarks, task completion was identical with and without collapse.

```
Before: "You are Claude Code, Anthropic's official CLI for Claude..." (5000+ tokens)
After:  "[system unchanged — hash:a7f3b2c1]" (10 tokens)
```

---

### 5.2 pruneUnusedTools — Remove Unused Tool Definitions

**What it does:** Claude Code sends 9 tool definitions (~7,000 tokens total) on every request. After 10 turns, if a tool has never been used by the model, its definition is removed from subsequent requests.

**Savings:** Typically removes 6 out of 9 tools (only Read, Bash, Edit are commonly used). Saves **~8,700 tokens per request**. In a 94-request session: **~730K tokens total**.

**Trigger:** After `pruneUnusedToolsAfter` turns (default 10). Only removes tools the model has never called.

**Cache impact:** Modifies the tools section (which comes before messages in the request). This changes the byte sequence early in the request, which means the first request after pruning will miss the cache for everything after the pruned section. Subsequent requests cache normally again.

**Risk:** If the model suddenly needs a pruned tool, it won't be available. In practice, Claude Code uses the same 3-4 tools consistently throughout a session.

```
Before: [Read, Write, Edit, Bash, Glob, Grep, Agent, WebFetch, NotebookEdit]
After:  [Read, Edit, Bash]  (only tools actually used in the session)
```

---

### 5.3 pruneStale — Summarise Old Tool Results

**What it does:** Tool results from early in the conversation accumulate and grow the context. After `pruneAfterTurns` turns (default 6), old tool results are replaced with a short summary.

**Savings:** The single biggest saver. Removes **1.5-2 million tokens** in a typical 85-100 request session.

**How it works:**

```
Before (message from turn 3):
  tool_result: "1  import { readFile } from 'node:fs';\n2  import ...\n3  ...\n" (500+ lines)

After (when current turn is 10+):
  tool_result: "[Read: 1 file, ~2,400 tokens — summary: TypeScript module, imports fs, defines class...]"
```

**Cache impact:** In a strict byte-prefix model this _looks_ cache-destructive — editing a mid-conversation result would invalidate everything after it. In practice on Bedrock it is not. With `insertBreakpoints` re-anchoring the 4 `cache_control` markers after the edit, the live runs held a ~100% hit rate (92 uncached tokens across 94 requests). The saving comes from carrying ~1.8M **fewer** tokens per session at an unchanged hit rate — not from accepting cache misses. See §6 for the mechanism and the simulation-vs-reality note.

**Risk:** The model loses access to the full content of old tool results. If it needs to reference specific details from 10+ turns ago, it will see only a summary. In benchmarks, this did not affect task completion.

---

### 5.4 suppressReread — Skip Reading Files Just Written

**What it does:** When the model writes a file (Edit, Write) and then immediately reads it back, the read result is suppressed with a stub:

```
[file just written in turn 5 — content already known, ~800 tokens suppressed]
```

**Savings:** Modest — typically 100-300 tokens per occurrence. Saves ~157 tokens total in benchmark sessions.

**Trigger:** Within `suppressWithinTurns` turns (default 2) of the write.

**Cache impact:** None — this operates on the response path (tool result content), not on existing conversation messages.

**Risk:** Low. The model just wrote the file, so it knows what's in it. Suppressing the re-read just avoids redundant context.

---

### 5.5 dedup — Suppress Duplicate Tool Calls

**What it does:** If the model calls the same tool with the same arguments and gets the same result hash as a previous call, the result is replaced with:

```
[unchanged since turn 3]
```

**Savings:** Small — typically 27-100 tokens. Only fires when the model calls the exact same tool+args and the result hasn't changed.

**Cache impact:** None — operates on the response path.

**Risk:** Very low. If the result truly hasn't changed, the stub is accurate.

---

### 5.6 truncate — Trim Oversized Results

**What it does:** When a tool result exceeds `truncateThreshold` (default 4,096 characters), it keeps the first 25 lines and last 30 lines, discarding the middle:

```
[... lines 26-470 truncated (445 lines, ~3,200 tokens) ...]
```

**Savings:** Variable — depends on how often the model reads large files. In benchmarks, triggered rarely because most reads are targeted.

**Cache impact:** None — operates on the response path.

**Risk:** Medium. If the relevant content is in the truncated middle, the model won't see it. In practice, models tend to read specific sections or grep first.

---

### 5.7 stablePrefix — Canonicalise Tool JSON

**What it does:** Sorts tool definition JSON keys into a canonical order, ensuring byte-identical encoding across requests even if the client sends them in different property orders.

**Savings:** 0 tokens — this doesn't reduce size. Its purpose is cache preservation.

**Cache impact:** Positive. Without canonicalisation, if tool definitions arrive with keys in different orders (e.g., `{name, description}` vs `{description, name}`), the cache would miss every time. This ensures consistent byte sequences.

**Risk:** None. The semantics are identical — only JSON key ordering changes.

---

### 5.8 insertBreakpoints — Restore Cache Markers

**What it does:** After other strategies modify the request (potentially destroying the client's `cache_control` markers), this strategy counts surviving markers and restores up to 4 total at optimal positions:

1. End of system prompt
2. End of tool definitions
3. Context boundary (second-to-last user message)
4. (Reserved for the client's own marker on the latest message)

**How it decides to act:**

```
markers_before_optimizations = count existing cache_control markers
... other strategies run and may destroy messages containing markers ...
markers_surviving = count remaining markers
budget = min(4, max(original_count, 3)) - surviving
→ place `budget` new markers at optimal positions
```

**Savings:** 0 tokens (markers are metadata, not content).

**Cache impact:** Positive safety net. Ensures that even after aggressive pruning, the cache markers exist at the most impactful positions. In benchmarks, achieved **92 uncached tokens** across 94 requests (vs 716 without the strategy).

**Risk:** None. Adding cache markers has no effect on model behaviour — they're metadata for the caching system only.

---

### 5.9 reorderVolatile — Move System Reminders to End

**What it does:** Claude Code injects `<system-reminder>` blocks into user messages. These contain volatile information (current date, available tools, git status) that changes between turns. If this volatile content sits in the middle of the cached prefix, it breaks the cache.

This strategy moves `<system-reminder>` blocks from earlier user messages to the last user message (which is past the last cache marker anyway).

**Savings:** 0 tokens — content is moved, not removed.

**Current status:** Active but rarely fires in practice. Claude Code's conversation structure means most user messages contain `tool_result` blocks (and we skip those to avoid breaking the tool_use→tool_result pairing constraint).

**Cache impact:** Theoretically positive (moving volatile content past the cache boundary). In simulation it appeared harmful, but in live benchmarks it rarely fires at all — most user messages in Claude Code sessions are tool-result responses, not pure text.

**Risk:** If the destination message contains tool_results, injecting text blocks would break the API constraint that `tool_use` must be immediately followed by `tool_result`. The implementation guards against this (skips messages with tool_results entirely).

**Bug found and fixed:** Initial implementation caused 400 API errors by injecting text into tool_result messages. Fixed by checking both source and destination for tool_result blocks.

---

## 6. Benchmark Results <a name="benchmark-results"></a>

### Test Setup

- **Fixture:** `iterative-fix-plus` — Claude Code fixes multiple bugs and implements 3 methods in a Node.js project
- **Model:** Opus 4.6 via AWS Bedrock (eu-west-1)
- **Conditions:** Each run is independent, fresh workspace, same task prompt
- **Verification:** 54 fixture tests + 57 edge-case tests after each run

### Phase 1: Early Results (Simulation + Single Live Run) — NOW INVALIDATED

> **WARNING:** These results were obtained before we understood cross-session cache warming
> and the cache-write penalty. They are preserved for historical reference only. The
> simulation model is fundamentally flawed for Anthropic/Bedrock. See Phase 2 below.

### Results Comparison (Phase 1 — OUTDATED)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COST COMPARISON (all runs)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  $2.67  ████████████████████████████████████████  cache-protective*         │
│  $2.04  ██████████████████████████████▋           no optimization           │
│  $0.52  ███████▉                                  full optimization (early) │
│  $0.48  ███████▏                                  full optimization         │
│  $0.44  ██████▋                                   full, no breakpoints      │
│                                                                             │
│  * cache-protective = pruneStale disabled to "protect cache" — proved wrong │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Metrics

| Run                           | Strategies                                 | Reqs | Input tokens | Uncached | Cache hit | Cost  | vs baseline    |
| ----------------------------- | ------------------------------------------ | ---- | ------------ | -------- | --------- | ----- | -------------- |
| **No optimization**           | none                                       | 70   | 3,917,198    | 716      | 100%      | $2.04 | —              |
| **Cache-protective**          | all except pruneStale                      | 118  | 4,978,066    | 762      | 100%      | $2.67 | **+31% worse** |
| **Full optimization (early)** | all strategies + breakpoints               | 85   | 817,455      | 730      | 100%      | $0.52 | **-74%**       |
| **Full optimization**         | all strategies + breakpoints + reorder fix | 94   | 776,366      | 92       | 100%      | $0.48 | **-77%**       |
| **Full, no breakpoints**      | all strategies, no breakpoint insertion    | 102  | 635,027      | 747      | 100%      | $0.44 | **-78%**       |

### Token Savings Breakdown (full optimization, 94 requests)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   TOKENS SAVED BY STRATEGY (3.17M total)                  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  pruneStale        ████████████████████████████████████  1,798,612 (57%) │
│  pruneUnusedTools  █████████████████                      729,540 (23%) │
│  collapseSystem    ███████████████                        639,768 (20%) │
│  insertBreakpoints (0 tokens — metadata only)                            │
│  stablePrefix      (0 tokens — cache preservation only)                  │
│                                                                          │
│  Total removed from requests: 3,167,920 tokens                           │
│  Net session cost: $0.48 (down from $2.04)                               │
└──────────────────────────────────────────────────────────────────────────┘
```

### Cache Performance

```
                    Uncached tokens per session
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  No optimization:       716 uncached  (99.98% cached)         │
│  Full, no breakpoints:  747 uncached  (99.88% cached)         │
│  Full optimization (early): 730 uncached (99.91% cached)      │
│  Full optimization:      92 uncached  (99.99% cached)  ◀──   │
│  Cache-protective:      762 uncached  (99.98% cached)         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

The **full optimization** run (with `insertBreakpoints`) achieved the lowest uncached tokens (92) because the breakpoint restoration ensures markers are always at optimal positions after pruning.

### Task Completion

All runs achieved identical task outcomes:

- **Fixture tests:** 54/54 passed (all runs)
- **Edge-case tests:** 54/57 passed (all runs, same 3 failures)

The optimization layer does not affect the model's ability to complete the task.

---

### What We Can and Can't Conclude

**Clear conclusions (high confidence):**

- `pruneStale` is the dominant cost-saving strategy (57% of savings)
- `collapseSystem` + `pruneUnusedTools` together save 43% of savings
- Disabling `pruneStale` to "protect cache" is counterproductive — bloated context costs more than cache misses
- `insertBreakpoints` achieves near-zero uncached tokens (92 vs 716-747)
- Task completion is unaffected by optimization

**Inconclusive (need more testing):**

- `reorderVolatile`: Rarely fires in Claude Code sessions (most user messages have tool_results). Need sessions with more pure-text user messages to evaluate its real impact.
- Optimal `pruneAfterTurns` threshold: We used the default (6). Shorter or longer sessions may benefit from different thresholds.
- Sessions with large files: The benchmark reads small files (<500 lines). Codebases with 2000+ line files would see more from `truncate` and different dynamics from `pruneStale`.
- Model variability: LLMs are non-deterministic. The same task can take 70-118 requests depending on the model's choices. Multiple runs of the same configuration are needed to establish statistical significance.
- Different task types: Our fixture is "fix bugs + implement methods." Exploration-heavy tasks (searching a codebase, reading documentation) would have different token profiles.

---

### Phase 2: Controlled Benchmarks (July 2026) — CURRENT

When we ran proper controlled benchmarks with multiple runs, tracking cross-session cache
effects, **the Phase 1 savings could not be reproduced**. Prefix-editing strategies that
appeared to save 77% in simulation **cause no measurable improvement** on real Bedrock traffic.

#### Why Phase 1 Results Were Wrong

1. **Cross-session cache warming (unfair baseline advantage).** Cache is keyed by byte
   prefix, not session ID. Baseline runs that share the same prefix get free cache reads
   from prior baselines. Optimized runs have a DIFFERENT prefix and start cold — paying
   expensive writes ($18.75/MTok) while baselines enjoy cheap reads ($1.50/MTok).

2. **Simulation doesn't model cache economics.** The simulator calculated savings as
   "tokens removed × flat input rate." It didn't model that ANY byte change triggers a
   cache WRITE at 12.5× the read rate. The "77% savings" were fictional.

3. **Model variance dominates.** The same task takes 21-70 requests depending on model
   non-determinism. Single-run comparisons are meaningless.

#### Controlled Results (Opus 4.6 Bedrock, iterative-fix-plus, multiple runs)

**Baseline (no optimization):**

| Run | Requests | Cost | Notes |
|-----|----------|------|-------|
| baseline-1 | 70 | $6.13 | Cold cache (first ever run) |
| baseline-2 | 21 | $2.67 | Warm cache from baseline-1 |
| baseline-3 | 25 | $2.41 | Warm cache |
| baseline-4 | 32 | $3.82 | Warm cache |

**Optimized (stripTools + tailTruncate, Bedrock-safe profile):**

| Run | Requests | Cached tokens | Cost | Notes |
|-----|----------|---------------|------|-------|
| opt-warmup | — | — | — | Cache primer (discarded) |
| opt-warm-1 | 40 | 1,613,688 | $4.13 | Warm cache for stripped prefix |

**Result: No significant improvement.** opt-warm-1 ($4.13) is within the variance of warm
baselines ($2.41-$6.13). The cost difference is explained by request count (40 vs 21-32),
which is model non-determinism — not optimization strategy.

#### Why Anthropic's Cache Cannot Be Beaten

The native cache achieves **98-99% read rate** on unmodified Claude Code requests. There is
almost nothing left to optimize:

```
Unmodified request (warm cache):
  Bytes 0..BP2 (system + tools + old messages) → CACHED READ ($1.50/MTok)
  Bytes BP2..BP3 (new message) → WRITE ($18.75/MTok)
  Read% ≈ 98-99%

ANY prefix modification (e.g., pruneStale removes old message content):
  Bytes 0..change_point → READ (unchanged prefix still matches)
  Bytes change_point..end → MISS → WRITE ($18.75/MTok)
  First request: massive write penalty
  Subsequent requests: must re-warm from modified prefix
```

The math: saving 7,500 tokens via stripTools saves `7,500 × $1.50/MTok = $0.011` per
request in reduced cache reads. Over 40 requests: ~$0.45. Modest but real.

#### What Strategies Are Safe for Bedrock

| Strategy | Safe? | Why |
|----------|-------|-----|
| **stripTools** | Yes (from turn 1) | Removes tools BEFORE any cache entry is written. Prefix is stable from the start. |
| **tailTruncate** | Yes | Only modifies the last user message (trailing edge = always a write). |
| collapseSystem | **NO** | Changes system bytes = different prefix = cache miss. |
| pruneUnusedTools | **NO** | Removes tools mid-session = new prefix = cold. |
| pruneStale | **NO** | Edits old messages = prefix diverges = writes. |
| stablePrefix | **NO** | Reorders tool JSON = different bytes = miss. |
| reorderVolatile | **NO** | Moves content = different bytes. |
| insertBreakpoints | **NO** | Adds markers to cached content = different bytes. |
| frozenCompact | **NO** | Rewrites history = prefix destroyed. |

#### The Bedrock-Safe Profile

```typescript
// EXPLICIT_CACHE_OVERRIDES — applied automatically for Anthropic/Bedrock
{
  collapseSystem: false,
  pruneUnusedTools: false,
  pruneStale: false,
  insertBreakpoints: false,
  reorderVolatile: false,
  frozenCompact: false,
  stableTruncate: false,
  shapeTestOutput: false,
  stablePrefix: false,
  tailTruncate: true,   // safe: only modifies trailing edge (always a write)
}
// Plus: stripTools: ["Workflow", "Agent", "ReportFindings"] (from turn 1, stable)
```

#### Measured Savings of Bedrock-Safe Strategies

| Strategy | Savings/request | Savings/session (40 reqs) | Annual (10 sessions/day) |
|----------|-----------------|---------------------------|--------------------------|
| stripTools (3 tools removed) | $0.011 | $0.45 | ~$1,350/year |
| tailTruncate | ~$0.001 | ~$0.03 | ~$90/year |
| **Total** | **$0.012** | **~$0.48** | **~$1,440/year** |

Combined: **~12% savings per session** (modest but consistent and safe).

---

## 7. Conclusions <a name="conclusions"></a>

### The Core Finding (Updated July 2026)

**For Anthropic/Bedrock: the native cache is near-optimal and cannot be meaningfully beaten
by request-level optimization.** Any modification to the cached prefix triggers expensive
cache writes ($18.75/MTok) that dwarf any savings from smaller context.

The only safe optimizations:
1. **stripTools** — remove unused tool definitions from turn 1 (~$0.45/session)
2. **tailTruncate** — truncate large results at the trailing edge (~$0.03/session)

### Why We Can't Beat the Cache — The Economics

| Metric | Value |
|--------|-------|
| Native cache read rate | 98-99% |
| Cache read cost | $1.50/MTok |
| Cache write cost | $18.75/MTok |
| Write-to-read penalty ratio | 12.5× |
| Tokens saved by stripTools | ~7,500/request |
| Value of those saved tokens | $0.011/request |
| Risk of prefix modification | $0.45+ per cache miss |

The fundamental constraint: cached tokens are already so cheap ($1.50/MTok) that reducing
their count saves pennies, while breaking the cache costs dollars.

### Where Gains ARE Possible (Future Work)

| Strategy | Potential | Status |
|----------|-----------|--------|
| **optimizeOnCold** | ~$0.94/cold return | Design complete, not implemented |
| **normalizePrefix** | ~$1.64/TTL window (5 devs) | Design complete, not implemented |
| **IASH (Intelligent Shell)** | ~83K tokens/session | Design complete, not implemented |
| **Keep-alive pings** | ~$0.45/prevented cold start | Trivial to implement |

See `docs/OPTIMIZATIONS-TODO.md` for detailed designs.

### What the Phase 1 "Simulation vs Reality" Note Got Wrong

The Phase 1 conclusion claimed "Anthropic's production cache tolerates edits inside a marked
region more gracefully than a naive prefix model assumes." This was based on a single live
run that appeared to maintain 100% cache hit rate with pruneStale active.

**We now believe this was a measurement artifact.** The live run benefited from cross-session
cache warming (prior baseline runs had already cached most of the prefix). The simulation's
prediction of cache misses from prefix editing is CORRECT — we just didn't observe them
because the baseline had already warmed the cache.

The controlled Phase 2 benchmarks (which account for cache state) confirm: any prefix
modification causes cold-cache behavior on the first request with the modified prefix.

### Open Questions

1. **Exact TTL** — How long does Bedrock's cache live? Use `benchmarks/cache-probe-bedrock.ts`
   with `PROBE_TTL=1` to measure empirically.
2. **optimizeOnCold threshold** — Is 5 min the right trigger? Does the cache live longer?
3. **normalizePrefix** — Can we get cross-user cache hits by rewriting paths?
4. **Long sessions (200+ requests)** — Do cumulative stripTools savings compound?
5. **Opus 4.8 pricing** — Same ratio (12.5× penalty) but different absolute costs ($0.50
   read, $6.25 write). Same conclusion applies.

---

## 8. DeepSeek Note <a name="deepseek-note"></a>

DeepSeek uses a fundamentally different caching model: **automatic prefix caching**. The server automatically caches the longest common prefix between consecutive requests — no client markers needed. This means:

- Any change to the prefix (even byte-level) invalidates the entire cache
- Strategies that modify early content (collapseSystem, pruneUnusedTools, pruneStale) are **catastrophic** for DeepSeek's cache
- Only "suffix-safe" strategies work: truncating/compressing content at the end of messages

The profiler detects DeepSeek sessions and applies a separate "cache-safe" strategy profile that disables all prefix-editing strategies and enables alternatives (`stableTruncate`, `shapeTestOutput`). This is documented separately in `docs/DEEPSEEK-CACHING.md`.

---

## Appendix: Profiler Export Example (Bedrock-safe profile)

Below is a truncated example of what `aap export <session>` produces with the current
Bedrock-safe profile (stripTools + tailTruncate only):

```
# Session bench-claude-iterative-fix-plus-20260712194942-1

- **Client:** claude
- **Working dir:** /private/tmp/aap-bench/iterative-fix-plus
- **Started:** 2026-07-12 19:49:42

## Summary

- Requests: 40
- Input tokens: 686 (uncached)
- Cached tokens: 1,613,688
- Output tokens: 2,196
- Estimated cost: $4.1275

## Optimizations applied

- Total tokens saved: ~295,551

| Strategy        | Actions | Tokens saved  |
|-----------------|--------:|--------------:|
| strip_tools     |      39 |   ~294,099    |
| tail_truncate   |       2 |     ~1,452    |

## Tool usage

| Tool | Calls | Result tokens |
|------|------:|--------------:|
| Bash |    18 |        ~5,200 |
| Read |    10 |        ~3,100 |
| Edit |     5 |          ~400 |
```

---

## Appendix: Configuration

### Bedrock-safe (recommended for Anthropic/Bedrock)

```toml
[optimize]
enabled = true
profile = "auto"       # auto-detects Bedrock → disables prefix-editing strategies

# stripTools removes from turn 1 (prefix stays stable, never invalidates cache)
# Default: ["Workflow", "Agent", "ReportFindings"]
# Customize based on which tools your workload never uses:
# stripTools = ["Workflow", "Agent", "ReportFindings", "NotebookEdit"]

# tailTruncate threshold (only truncates in the LAST user message — always a write)
truncateThreshold = 4096

# Pricing (for cost reporting)
[pricing."eu.anthropic.claude-opus-4-6-v1"]
inputPerMTok = 15.0
outputPerMTok = 75.0
cacheInputPerMTok = 1.5
cacheWritePerMTok = 18.75

[pricing."eu.anthropic.claude-opus-4-8"]
inputPerMTok = 5.0
outputPerMTok = 25.0
cacheInputPerMTok = 0.50
cacheWritePerMTok = 6.25
```

### Full optimization (for DeepSeek or offline simulation only)

```toml
[optimize]
enabled = true
profile = "default"    # Forces full layer — ONLY use for non-Anthropic providers

pruneAfterTurns = 6
pruneUnusedToolsAfter = 10
truncateThreshold = 4096
suppressWithinTurns = 2
```

---

## Appendix: Related Documentation

- `docs/CACHE-BENCHMARK-METHODOLOGY.md` — How Bedrock's byte-prefix cache works,
  cross-session warming problem, fair benchmark approaches
- `docs/DEEPSEEK-CACHING.md` — DeepSeek's automatic prefix cache and safe strategies
- `docs/OPTIMIZATIONS-TODO.md` — Future optimization roadmap (normalizePrefix, optimizeOnCold, IASH)
- `benchmarks/cache-probe-bedrock.ts` — Empirical cache behavior probe (TTL, cross-session)
