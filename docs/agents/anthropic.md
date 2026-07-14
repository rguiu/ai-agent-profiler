# Anthropic / Bedrock (explicit cache) — agent notes

How the profiler treats Claude Code traffic (Anthropic API and AWS Bedrock), why the
native cache is effectively unbeatable by request rewriting, and what we explored.

> **Cache family:** `explicit` (client-placed `cache_control` breakpoints).
> **Optimizer stance:** prompt-editing strategies are **disabled**; cached traffic is
> passed through untouched. The layer is off by default.
> See [`../optimization/FINDINGS.md`](../optimization/FINDINGS.md) and the canonical
> [`../CACHE-BENCHMARK-METHODOLOGY.md`](../CACHE-BENCHMARK-METHODOLOGY.md).

---

## 1. How Anthropic caching works

Anthropic's cache is **explicit**: the client opts in by placing `cache_control`
markers in the request. Without markers, nothing is cached.

```json
{
  "system": [
    {"type": "text", "text": "..."},
    {"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}
  ],
  "tools": [ ... ],
  "messages": [
    ...,
    {"role": "user", "content": [
      {"type": "tool_result", "content": "...", "cache_control": {"type": "ephemeral"}}
    ]}
  ]
}
```

Each marker is a **breakpoint**. The API caches everything from position 0 up to each
breakpoint as an entry, keyed by the **exact byte sequence** of the serialized request
(system, then tools, then messages). Any change to any byte before a breakpoint
invalidates that entry — reordering, whitespace, a single character in a tool
description, adding/removing a tool, or editing a past message.

### Facts that shape the economics

- **Write vs read.** A cache _read_ (bytes match a prior prefix) is cheap; a cache
  _write_ (new content up to a breakpoint) costs materially more — on the order of
  **~12.5× the read rate** (roughly 1.25× the base input rate). Converting reads to
  writes by editing the prefix is the expensive failure mode.
- **Minimum cacheable block ≈ 2048 tokens.** Content up to a breakpoint smaller than
  this is billed as regular input even with a marker present. (Claude Code's system
  prompt alone exceeds this many times over.)
- **`input_tokens` is fresh-only.** Anthropic/Bedrock report `input_tokens` as
  non-cached input, with cache reads/writes counted separately — unlike DeepSeek/OpenAI
  where `input_tokens` is the whole prompt. The profiler's cost model accounts for the
  three disjoint buckets (fresh / cache-read / cache-write) per provider.
- **TTL.** Ephemeral entries live "at least 5 minutes" from last use; exact behaviour is
  undocumented. After expiry the next request re-pays the write cost.

### Where Claude Code places breakpoints

Claude Code already places its own breakpoints (typically after a short system preamble,
after the full system prompt, and on the trailing edge of the latest message). The stable
system + tools + conversation prefix is cached after each turn, so unmodified requests
achieve a **very high read rate** — there is little left for a proxy to improve.

---

## 2. Why request rewriting can't beat the native cache

The prefix-editing strategies (prune old results, collapse the system prompt, prune
unused tools, reorder, insert/replace breakpoints) all change bytes **before** a
breakpoint. On Anthropic that turns cheap cache reads into expensive cache writes — and
because cached tokens are already cheap, the write penalty dwarfs any saving from a
smaller prompt. The net effect is neutral-to-negative.

This mirrors the DeepSeek conclusion ([`deepseek.md`](deepseek.md)) via a different
mechanism: DeepSeek re-bills the downstream tail at the miss rate; Anthropic re-bills the
changed region at the write rate. Either way, **editing the cached prefix loses.**

The profiler encodes this by mapping `anthropic`/`bedrock` to the `explicit` cache family
(`src/optimize/profiles.ts`), which disables prompt-editing and passes cached traffic
through. Only edits confined to the trailing edge (never re-touching earlier turns) are
considered safe. See [`../OPTIMIZATION-STRATEGIES.md`](../OPTIMIZATION-STRATEGIES.md).

---

## 3. Cold vs warm cache — what we explored

Because the cache key is the byte prefix (not the session id), it persists **across
sessions**: a later request that shares a prefix with an earlier one gets a read instead
of a write. This has two consequences we observed on Claude:

- **Benchmarks are easily confounded.** Repeated baseline runs share a prefix, so the
  second and later baselines enjoy free reads warmed by the first — making them look
  cheaper than a first-time "optimized" run whose _different_ prefix starts cold. Any fair
  comparison must warm both arms equally (e.g. discard the first run of each), or compare
  cold-vs-cold. See [`../CACHE-BENCHMARK-METHODOLOGY.md`](../CACHE-BENCHMARK-METHODOLOGY.md).
- **Cold returns are the real opportunity.** When a session returns after the TTL has
  expired, the next request re-writes the whole prefix anyway. That is the one moment
  where shrinking the prompt is close to free (the write happens regardless), so a
  returning/idle session could benefit from a one-time rewrite. This is a future
  direction, not implemented — see [`../OPTIMIZATIONS-TODO.md`](../OPTIMIZATIONS-TODO.md)
  (`optimizeOnCold`, keep-alive pings, prefix normalization).

`benchmarks/cache-probe-bedrock.ts` measures cold/warm, cross-session, and (with
`PROBE_TTL=1`) TTL behaviour empirically.

---

## 4. New: 1h cache TTL upgrade

Claude Code always requests the 5-minute cache (`cache_control: { type: "ephemeral" }`).
AAP can rewrite these markers to request a 1-hour TTL before forwarding upstream.

**How it works:**

- `aap run claude --cache-1h` sets `cache_ttl: "1h"` in session metadata.
- The proxy detects the metadata and calls `applyCacheTtlUpgrade()` — a standalone
  function extracted from the optimizer — which walks the JSON body and bumps every
  ephemeral `cache_control` marker to `{ type: "ephemeral", ttl: "1h" }`.
- Works **without** `--optimize`. Pure cache-lifecycle operation.

**Cost model (Opus 4.x on Bedrock):**

| TTL           | Write cost  | Read cost    | Break-even idle         |
| ------------- | ----------- | ------------ | ----------------------- |
| 5m (default)  | 1.25× input | 0.125× input | —                       |
| 1h (upgraded) | 2.0× input  | 0.125× input | Idle gaps > 5 min, < 1h |

The 1h upgrade costs 2× on writes but survives 12× longer. It wins when idle gaps
often fall between 5 minutes and 1 hour. With keep-alive (pings every 48 min instead
of 4 min), it's the most cost-effective combo for long sessions.

**Implementation:** `src/optimize/layer.ts:applyCacheTtlUpgrade()`. Verified compiling.
Live verification (send two requests 6 min apart, check cache hit) is pending.

---

## 5. Keep-alive on Anthropic/Bedrock

`AAP_KEEP_ALIVE=1 aap run claude` replays the last request with `max_tokens: 1` to
prevent cache expiry during idle. Pings go through the proxy with `x-aap-keep-alive: 1`
and are highlighted in the dashboard.

| Cache TTL         | Ping interval | Pings to break even | Best use                       |
| ----------------- | ------------- | ------------------- | ------------------------------ |
| 5m                | 4 min         | ~12.5               | Short idle gaps (< 5 min)      |
| 1h (`--cache-1h`) | 48 min        | ~20                 | Longer gaps, intermittent work |

For the 1h cache: 20 pings × $0.10/ping = $2.00, same as one rebuild. Wins if the
user returns to the session within a few hours.

---

## 6. Wrapper approach: JSONL compaction

With JSONL compaction (see [`../wrapper/CLAUDE-JSONL.md`](../wrapper/CLAUDE-JSONL.md)),
the optimization is applied ONCE to Claude's local JSONL file. Claude then stores the
compacted version and re-sends it identically every turn.

On Anthropic/Bedrock:

- The cache write cost at the compacted size is a one-time event.
- Every subsequent turn hits the cache at the compacted size (~$0.50/MTok reads).
- Net savings = (reduction per turn × turns after compaction) - (one compacted write).

Because Anthropic charges a premium for cache writes (1.25× or 2×), the break-even
is slower than on DeepSeek. Compaction strategies that make economic sense:

- `stableTruncate` — deterministic, small per-turn reduction
- `stripTools` — removes tool defs from turn 1 (served from system breakpoint)
- `collapseSystem` — collapses repeated system prompt to hash stub

**Status:** JSONL compaction not yet implemented. Read-only analysis tool
(`aap analyze-claude`) exists to measure what compaction would save.

---

## 7. Open questions

- Verify 1h cache TTL is actually honored by Bedrock (6-min gap test pending).
- Exact Bedrock/Anthropic cache TTL under sustained use.
- Whether `optimizeOnCold` (rewrite only when the cache has expired) yields reliable
  savings — proven **not** to work (double write); removed from code.
- Team-shared cache via prefix normalization (cross-user reads) — see TODO.
</content>
