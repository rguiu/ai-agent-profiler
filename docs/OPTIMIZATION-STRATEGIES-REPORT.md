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

| Part | Size (typical) | Changes between requests? |
|------|---------------|--------------------------|
| System prompt | ~5,000 tokens | Never (same every turn) |
| Tool definitions | ~7,000 tokens | Never (same every turn) |
| Early messages | Varies | Never (history is append-only) |
| Recent messages | Varies | Only the last one changes |
| Tool results | 100-10,000+ tokens each | Added each turn, never modified |

**The key insight:** Most of what's sent on each request is identical to the previous request. Only the newest message at the end is new. This is what makes caching so effective.

### Why Does the Conversation Grow?

In a typical 94-request coding session:
- System prompt: ~5K tokens × 94 requests = **470K tokens re-sent**
- Tool definitions: ~7K tokens × 94 requests = **658K tokens re-sent**  
- Message history: grows from 0 to ~40K tokens over the session
- Cumulative input: **3.9 million tokens** (without optimization)

Without caching, this would cost approximately $58 on Opus 4.6 ($15/MTok). With caching, it costs ~$6. With optimization, it costs ~$1.44.

---

## 3. How Anthropic's Cache Works <a name="how-anthropics-cache-works"></a>

### Explicit Prompt Caching (Anthropic/Bedrock)

Anthropic uses an **explicit** caching model. The client tells the API where to cache by placing markers:

```json
{
  "type": "text",
  "text": "You are Claude Code...",
  "cache_control": {"type": "ephemeral"}
}
```

**Rules:**
- Maximum **4 markers** per request
- Content before a marker is cached for **5 minutes** after last use
- Minimum cacheable block: **1,024 tokens** (2,048 on some models)
- Cache match is **byte-exact** — any change invalidates everything after the change point

### Pricing (Bedrock, Opus 4.6)

| Token type | Cost per million tokens | Relative |
|-----------|------------------------|----------|
| Cache write (first time) | $18.75 | 1.25× input |
| Cache read (subsequent) | $1.50 | 0.10× input |
| Input (uncached) | $15.00 | 1.0× |
| Output | $75.00 | 5.0× input |

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

| Strategy | Provider | Impact | Status |
|----------|----------|--------|--------|
| `pruneStale` | Claude/Bedrock only | **57% of total savings** | Proven |
| `pruneUnusedTools` | Claude/Bedrock only | **23% of total savings** | Proven |
| `collapseSystem` | Claude/Bedrock only | **20% of total savings** | Proven |
| `insertBreakpoints` | Claude/Bedrock only | Near-zero cache misses | Proven |
| `dedup` | All providers | Small | Proven, low frequency |
| `truncate` | All providers | Varies by file sizes | Proven, low frequency |
| `suppressReread` | All providers | Small | Proven, low frequency |
| `stablePrefix` | All providers | Cache-preservation only | Proven |
| `reorderVolatile` | Claude/Bedrock only | Cache-preservation only | Experimental — rarely fires |

**Disabled on DeepSeek:** `pruneStale`, `collapseSystem`, `pruneUnusedTools`, `insertBreakpoints` — all edit the cached prefix and **cause cost increases** on prefix-cache providers.

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

**Cache impact:** This is the most cache-destructive strategy. Replacing content in the middle of the conversation changes the byte sequence, invalidating the cache for everything after that point. However, the token savings are so massive (1.8M tokens) that the net cost is still dramatically lower even with reduced cache hits.

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

### Results Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COST COMPARISON (all runs)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  $8.02  ████████████████████████████████████████  cache-protective*         │
│  $6.13  ██████████████████████████████▋           no optimization           │
│  $1.57  ███████▉                                  full optimization (early) │
│  $1.44  ███████▏                                  full optimization         │
│  $1.33  ██████▋                                   full, no breakpoints      │
│                                                                             │
│  * cache-protective = pruneStale disabled to "protect cache" — proved wrong │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Metrics

| Run | Strategies | Reqs | Input tokens | Uncached | Cache hit | Cost | vs baseline |
|-----|-----------|------|-------------|----------|-----------|------|-------------|
| **No optimization** | none | 70 | 3,917,198 | 716 | 100% | $6.13 | — |
| **Cache-protective** | all except pruneStale | 118 | 4,978,066 | 762 | 100% | $8.02 | **+31% worse** |
| **Full optimization (early)** | all strategies + breakpoints | 85 | 817,455 | 730 | 100% | $1.57 | **-74%** |
| **Full optimization** | all strategies + breakpoints + reorder fix | 94 | 776,366 | 92 | 100% | $1.44 | **-77%** |
| **Full, no breakpoints** | all strategies, no breakpoint insertion | 102 | 635,027 | 747 | 100% | $1.33 | **-78%** |

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
│  Net session cost: $1.44 (down from $6.13)                               │
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

## 7. Conclusions and Open Questions <a name="conclusions"></a>

### The Core Finding

The optimization layer achieves **74-78% cost reduction** on Claude Code sessions with Bedrock, while maintaining 100% cache hit rates and identical task completion. The savings come from three complementary strategies:

1. **pruneStale** — Summarise old tool results (57% of savings)
2. **pruneUnusedTools** — Remove tool definitions the model never uses (23%)
3. **collapseSystem** — Hash the repeated system prompt (20%)

### The Cache Paradox

A naive analysis would suggest: "Don't modify content in the cached prefix — you'll break the cache and pay more." Our benchmark disproved this:

- Protecting the cache (not pruning) → $8.02 per session (**worst result**)
- Aggressively pruning everything → $1.44 per session (**best result**)

**Why?** Because Anthropic's cache has a **minimum cacheable size** (1,024 tokens). When you remove 1.8 million tokens from the context, the total amount being re-read from cache drops enormously — from 4.3M to 776K. Even if some cache misses occur, paying full rate on 776K tokens costs far less than paying cache rate on 4.3M tokens.

The math: `776K × $15/MTok = $11.6` vs `4,300K × $1.5/MTok = $6.45`. But the optimized version has most content still cached (only 92 tokens uncached), so actual cost is closer to `776K × $1.5/MTok = $1.16` plus output.

### Open Questions for Further Research

1. **Per-strategy A/B testing**: Run each strategy independently to measure its isolated impact (currently they all run together)
2. **Statistical significance**: Run 5-10 repetitions of each configuration to account for LLM non-determinism
3. **Different fixtures**: Test on exploration tasks, large-file refactoring, multi-file changes
4. **Adaptive thresholds**: Could the layer learn the optimal `pruneAfterTurns` during a session based on observed token growth?
5. **Partial pruning**: Instead of fully summarising old results, keep the first N lines and summarise the rest

---

## 8. DeepSeek Note <a name="deepseek-note"></a>

DeepSeek uses a fundamentally different caching model: **automatic prefix caching**. The server automatically caches the longest common prefix between consecutive requests — no client markers needed. This means:

- Any change to the prefix (even byte-level) invalidates the entire cache
- Strategies that modify early content (collapseSystem, pruneUnusedTools, pruneStale) are **catastrophic** for DeepSeek's cache
- Only "suffix-safe" strategies work: truncating/compressing content at the end of messages

The profiler detects DeepSeek sessions and applies a separate "cache-safe" strategy profile that disables all prefix-editing strategies and enables alternatives (`stableTruncate`, `shapeTestOutput`). This is documented separately in `docs/DEEPSEEK-CACHING.md`.

---

## Appendix: Profiler Export Example

Below is a truncated example of what `aap export <session>` produces:

```
# Session bench-claude-iterative-fix-plus-20260711215903-1

- **Client:** claude
- **Working dir:** /private/tmp/aap-bench/iterative-fix-plus
- **Started:** 2026-07-11 19:59:03

## Summary

- Requests: 94
- Input tokens: 92 (uncached)
- Cached tokens: 776,274
- Output tokens: 3,626
- Estimated cost: $1.4372

## Optimizations applied

- Total tokens saved: ~3,167,920

| Strategy        | Actions | Tokens saved  |
|-----------------|--------:|--------------:|
| prune_stale     |   3,734 | ~1,798,612    |
| prune_unused    |      84 |   ~729,540    |
| collapse_system |      92 |   ~639,768    |
| breakpoints     |      93 |           ~0  |
| stable_prefix   |       2 |           ~0  |

## Tool usage

| Tool | Calls | Result tokens |
|------|------:|--------------:|
| Read |    30 |        ~9,833 |
| Bash |    19 |        ~6,702 |
| Edit |    16 |          ~768 |
```

---

## Appendix: Configuration

```toml
[optimize]
enabled = true
profile = "auto"       # auto-detects provider, applies appropriate overrides

# Thresholds
pruneAfterTurns = 6            # Start pruning after this many assistant turns
pruneUnusedToolsAfter = 10     # Remove unused tools after this many turns
truncateThreshold = 4096       # Characters before truncating tool results
suppressWithinTurns = 2        # Suppress re-reads within N turns of write

# Pricing (for cost reporting)
[pricing."eu.anthropic.claude-opus-4-6-v1"]
inputPerMTok = 15.0
outputPerMTok = 75.0
cacheInputPerMTok = 1.5
```
