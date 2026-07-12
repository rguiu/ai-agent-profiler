# Optimization: what we tried, and why it didn't beat the cache

The profiler ships an optional in-flight **optimize layer** that can rewrite agent
requests before they reach the model, aiming to cut token cost on long coding sessions.
This document is the honest summary of that effort: what we tried, why the ambitious
version did not pay off on real traffic, what remains safe, and where genuine gains might
still be found.

**Bottom line:** on providers with prompt caching (Anthropic/Bedrock and DeepSeek/OpenAI),
the native cache is already close to optimal for the way coding agents send requests.
The high-impact ideas all involved _editing the cached prefix_, and editing the prefix
costs more than it saves. The layer is therefore **off by default**, and when enabled it
passes cached traffic through largely untouched.

---

## What we tried

Coding agents re-send the whole conversation every turn: system prompt, tool definitions,
and the full message history, growing with each step. That looks like enormous
redundancy, so the layer implemented strategies to shrink it — summarise old tool results
(`pruneStale`), drop the repeated system prompt (`collapseSystem`), remove never-used tool
definitions (`pruneUnusedTools`), compact history (`frozenCompact`), reorder volatile
content, and re-anchor cache markers. Full catalogue:
[`OPTIMIZATION-STRATEGIES.md`](OPTIMIZATION-STRATEGIES.md).

Early benchmarks looked spectacular. They were wrong.

## Why it didn't work

Two facts about prompt caching make prefix-editing a losing trade:

1. **Cached tokens are already cheap, and editing the prefix is expensive.** Providers
   cache a _prefix_ of the request. On Anthropic/Bedrock, re-using cached content is a
   cheap "read", but any change before a cache boundary forces a "write" costing on the
   order of **~12.5× the read rate**. On DeepSeek the cache is an automatic token-prefix;
   editing it re-bills everything downstream at the miss rate (~10× the hit rate). Either
   way, shrinking a prompt that was already caching cheaply trades pennies of saved reads
   for dollars of new writes/misses.

2. **The early "wins" were measurement artifacts.** The cache key is the byte prefix, not
   the session — so it persists across runs. Repeated baseline runs share a prefix and get
   free reads warmed by earlier baselines, while a first-time "optimized" run has a
   _different_ prefix and starts cold. On top of that, the cost model initially did not
   count cache-**write** tokens at all, so it under-reported exactly the cost that
   prefix-editing creates. Once the cost accounting was fixed and cache warming was
   controlled for, the apparent savings disappeared.

The two providers reach the same conclusion by different mechanisms. Details:
[`agents/anthropic.md`](agents/anthropic.md), [`agents/deepseek.md`](agents/deepseek.md),
and the canonical cache mechanics in
[`CACHE-BENCHMARK-METHODOLOGY.md`](CACHE-BENCHMARK-METHODOLOGY.md).

## What remains

The layer keeps only the edits that don't disturb the cached prefix — transforms confined
to the trailing edge, or tool removal applied from turn 1 so the prefix is stable from the
start. These are modest and safe. Everything that edits the middle of the prompt is
disabled automatically per provider (via the cache-family mapping in
`src/optimize/profiles.ts`). The default posture is: **profile, don't rewrite.**

## Where gains might still exist

The one situation where shrinking the prompt is genuinely free is when the cache has
**expired** — the next request re-writes the whole prefix regardless, so making it smaller
costs nothing extra. That points at a few unexplored directions:

- **Cold/idle-session rewrite (`optimizeOnCold`).** Detect that the cache TTL has lapsed
  and apply aggressive shrinking only on that first "write anyway" request.
- **Keep-alive / prefix normalization.** Keep a shared prefix warm, or normalize
  per-user paths so a team shares cache reads.
- **IASH and result-shaping at the source** — reduce what enters the context in the first
  place rather than editing it afterward.

These are designed but not implemented; see [`OPTIMIZATIONS-TODO.md`](OPTIMIZATIONS-TODO.md).

We explored cold-vs-warm cache behaviour on **Claude** (see
[`agents/anthropic.md`](agents/anthropic.md)); the equivalent for **DeepSeek is not yet
known**. Any future claim of improvement will be stated only with reliable, repeated
measurements (agent behaviour is non-deterministic) and a cache warmed equally across
comparison arms — the standard the early numbers failed to meet.

---

## Related documents

- [`OPTIMIZATION-STRATEGIES.md`](OPTIMIZATION-STRATEGIES.md) — per-strategy catalogue and safety table.
- [`CACHE-BENCHMARK-METHODOLOGY.md`](CACHE-BENCHMARK-METHODOLOGY.md) — how the caches work and how to benchmark them fairly.
- [`agents/anthropic.md`](agents/anthropic.md), [`agents/deepseek.md`](agents/deepseek.md) — per-provider notes.
- [`OPTIMIZATIONS-TODO.md`](OPTIMIZATIONS-TODO.md) — future directions in detail.

> Earlier reports whose savings figures predate the cache-write cost fix have been
> retired; the numbers there were overstated and should not be relied on.
> </content>
