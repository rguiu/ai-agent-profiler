# Optimize Layer — Ideas & Findings

Tracking document for optimization improvements explored on the `feat/deepseek-cache-optimize` branch.

## Baseline reference (Jul 11, 2026)

All benchmarks: iterative-fix-plus fixture, Claude Code, Opus 4.6 via Bedrock (eu-west-1).

| Condition                         | Reqs | Input tokens | Cached    | Hit%   | Cost  | vs baseline |
| --------------------------------- | ---- | ------------ | --------- | ------ | ----- | ----------- |
| baseline (no optimize)            | 70   | 3,917,198    | 3,916,482 | 100.0% | $6.13 | —           |
| opt-full (all + breakpoints)      | 85   | 817,455      | 816,725   | 99.9%  | $1.57 | -74%        |
| opt-nobreak (all, no breakpoints) | 47   | 212,877      | 212,184   | 99.7%  | $0.47 | -92%        |

Key finding: Claude Code already manages cache markers perfectly. The token-reduction strategies (pruneStale -1.55M, collapseSystem -577K, pruneUnusedTools -651K) are what drive cost savings.

---

## Simulation results (Jul 11, post-fix)

After fixing the simulator's chunked-body bug (was only reading first 64KB chunk), full session replay now shows accurate strategy impact:

### 85-request session (baseline fixture, Haiku 4.5)

| Variant                                | Tokens saved | Cache hit% | Cache cost delta |
| -------------------------------------- | ------------ | ---------- | ---------------- |
| Token reduction only                   | 2,783,284    | 67.1%      | -$19.37          |
| + breakpoints (A)                      | 1,228,714    | 87.3%      | -$18.16          |
| + breakpoints + volatile reorder (A+D) | 1,228,714    | 74.8%      | -$12.91          |

### 102-request session (baseline fixture, Haiku 4.5)

| Variant                                | Tokens saved | Cache hit% | Cache cost delta |
| -------------------------------------- | ------------ | ---------- | ---------------- |
| Token reduction only                   | 3,574,863    | 70.6%      | -$24.04          |
| + breakpoints (A)                      | 1,494,518    | 88.8%      | -$22.14          |
| + breakpoints + volatile reorder (A+D) | 1,494,518    | 77.4%      | -$15.84          |

### Key takeaways

1. **pruneStale is the biggest token saver** (~1.5-2M tokens) but degrades cache hit rate from 87% → 67%. Cache-aware mode (Idea B) correctly suppresses it to preserve cache.
2. **Cache-aware pruning (B) trades tokens for cache**: Saves $1-2 less in absolute cost delta but achieves 20% higher cache hit rate. Net effect is provider-dependent.
3. **Volatile reorder (D) is harmful**: Drops cache hit by 10-14 percentage points, costing $4-6 extra per session. **Disabled by default.**
4. **breakpoints alone (A)** have negligible direct impact — Claude Code manages its own markers.

---

## Idea A: insertCacheBreakpoints (IMPLEMENTED)

**Status:** Done (commits 8ba0126, 97b6709)

**Hypothesis:** Placing `cache_control` markers at stable-layer boundaries would improve cache hit rates for clients that don't manage their own caching.

**Finding:** Claude Code already places 4 markers — our strategy is effectively a no-op for it. But it acts as a safety net: restores markers destroyed by other strategies, and provides free cache optimization for naive clients.

**Design:** Strategic restore-after-destroy policy. Count markers before optimizations, count after, fill gaps at optimal positions (system, tools, context boundary). Never exceed Anthropic's 4-marker cap.

**Simulation impact:** Negligible token savings, negligible cache cost change when pruneStale is suppressed.

---

## Idea B: Cache-aware pruning (IMPLEMENTED)

**Status:** Done (commit 6052177)

**Hypothesis:** `pruneStale` currently prunes by age (after N turns). On Anthropic/Bedrock, old messages inside the cached prefix cost only $0.50/MTok to re-read — pruning them saves $0.50/MTok per token removed but can break the cache prefix for everything after, costing $5/MTok for the miss on subsequent content. Net effect could be negative.

**Approach:** When `insertBreakpoints` is active (explicit-cache provider), skip pruning messages that precede the last surviving cache breakpoint. Only prune in the "fresh" tail after the final breakpoint.

**Simulation finding:** Cache-aware pruning completely suppresses pruneStale (0 actions), which trades 1.5-2M fewer tokens saved for 20% higher cache hit rate. Net cost effect: loses $1-2 of savings vs aggressive pruning. This is the correct trade-off for Anthropic/Bedrock where cached token reads are 10x cheaper than misses.

**Current behavior:** When `insertBreakpoints: true`, the layer protects all content at/before the last cache marker from being pruned. This may be too aggressive — future refinement could allow pruning content that is far enough past the last marker.

---

## Idea C: Tool-def compression / cost attribution (IMPLEMENTED)

**Status:** Done (commit 6052177) — tracking only

**Hypothesis:** Tool definitions account for ~980K tokens resent across 85 requests in the benchmark. They're cached (free at $0.50/MTok read rate) but contribute to wire transfer time and context window pressure. Track this as a metric.

**Approach:** Added `toolDefTokens` metric to the optimize layer. Surface in `aap export` and the simulator. The compression strategy (hash-stub on subsequent turns) was deferred as too complex for the proxy architecture.

**Simulation finding:** `pruneUnusedTools` correctly removes unused tool definitions after 10 turns, saving 521K-799K tokens per session.

---

## Idea D: Volatile content reordering (IMPLEMENTED — DISABLED)

**Status:** Done (commit 6052177) — **disabled by default** after simulation showed negative results.

**Hypothesis:** Claude Code injects `<system-reminder>` blocks (current date, deferred tools list, git status, skill context) into user messages. These change between turns and can break prefix-match for everything after them. If volatile content is moved to the final user message (past the last breakpoint), the stable prefix above remains cache-eligible.

**Simulation finding:** HARMFUL. Moving system-reminder blocks to the last user message changes content in the middle of the message history (the source messages lose their content), which breaks byte-identity for all subsequent content. Cache hit rate drops 10-14 percentage points, costing $4-6 extra per session.

**Why it fails:** The hypothesis assumed that removing volatile content from earlier messages would make those messages more stable between turns. But the content removal ITSELF is the change — the previous turn's cached version had that content in place. On the next turn, the content is gone from that position, breaking the prefix match.

**Correct approach (future):** Instead of moving content, _duplicate_ it at the end (so the original stays in place for cache stability) and mark the duplicate with `cache_control` for fresh-data emphasis. Or accept that system-reminders are already cached effectively by Claude Code's 4-marker placement.

---

## Idea E: Cost attribution per strategy (IMPLEMENTED)

**Status:** Done (commit 6052177)

**Hypothesis:** A strategy that saves 1000 tokens but breaks 50K tokens of cache actually costs money. We need net-cost modeling, not just token-saved counts.

**Approach:** Extended the simulator's cache-cost model to compute per-variant cache cost deltas. The `cacheRate` field on `OptimizeAction` tracks whether a pruned block was inside the cached prefix.

**Simulation finding:** The cache-cost model clearly shows the trade-offs:

- Token reduction only: highest savings ($19-24 delta) but lowest cache hit (67-70%)
- With cache protection: slightly less savings ($14-22 delta) but much higher cache hit (85-88%)
- The net cost difference is modest ($1-2) because cached tokens are so cheap to re-read

---

## Findings log

- 2026-07-11: Claude Code places 4 cache_control markers per request (Bedrock sessions show 99-100% hit rate with no proxy intervention)
- 2026-07-11: Naive breakpoint insertion exceeded Anthropic's 4-marker cap → 400 error. Fixed with strategic restore-after-destroy policy.
- 2026-07-11: opt-nobreak (full optimize, no breakpoints) achieved 99.7% cache hit and $0.47 cost — best result. Suggests breakpoints add no value for Claude Code.
- 2026-07-11: Per-request uncached tokens: baseline 10 tok/req, optimize 9 tok/req — nearly identical, confirming Claude Code's built-in caching is already optimal.
- 2026-07-11: Model used was Opus 4.6 (not 4.8 as initially assumed) — user's default ANTHROPIC_DEFAULT_OPUS_MODEL setting.
- 2026-07-11: **Simulator bug found and fixed**: chunked request bodies (>64KB) were only partially read. Fix: decode each base64 chunk independently, then Buffer.concat. This revealed the full optimization potential that was previously hidden.
- 2026-07-11: **Volatile reorder is cache-hostile**: simulation proves moving content between messages breaks prefix-match. Disabled in EXPLICIT_CACHE_OVERRIDES.
- 2026-07-11: **pruneStale is the dominant strategy** (1.5-2M tokens saved per 85-102 req session) but its cache impact depends on provider family. Cache-aware mode correctly suppresses it for explicit-cache providers.
