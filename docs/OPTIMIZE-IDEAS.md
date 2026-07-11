# Optimize Layer — Ideas & Findings

Tracking document for optimization improvements explored on the `feat/deepseek-cache-optimize` branch.

## Baseline reference (Jul 11, 2026)

All benchmarks: iterative-fix-plus fixture, Claude Code, Opus 4.6 via Bedrock (eu-west-1).

| Condition | Reqs | Input tokens | Cached | Hit% | Cost | vs baseline |
|-----------|------|-------------|--------|------|------|-------------|
| baseline (no optimize) | 70 | 3,917,198 | 3,916,482 | 100.0% | $6.13 | — |
| opt-full (all + breakpoints) | 85 | 817,455 | 816,725 | 99.9% | $1.57 | -74% |
| opt-nobreak (all, no breakpoints) | 47 | 212,877 | 212,184 | 99.7% | $0.47 | -92% |

Key finding: Claude Code already manages cache markers perfectly. The token-reduction strategies (pruneStale -1.55M, collapseSystem -577K, pruneUnusedTools -651K) are what drive cost savings.

---

## Idea A: insertCacheBreakpoints (IMPLEMENTED)

**Status:** Done (commits 8ba0126, 97b6709)

**Hypothesis:** Placing `cache_control` markers at stable-layer boundaries would improve cache hit rates for clients that don't manage their own caching.

**Finding:** Claude Code already places 4 markers — our strategy is effectively a no-op for it. But it acts as a safety net: restores markers destroyed by other strategies, and provides free cache optimization for naive clients.

**Design:** Strategic restore-after-destroy policy. Count markers before optimizations, count after, fill gaps at optimal positions (system, tools, context boundary). Never exceed Anthropic's 4-marker cap.

---

## Idea B: Cache-aware pruning

**Status:** In progress

**Hypothesis:** `pruneStale` currently prunes by age (after N turns). On Anthropic/Bedrock, old messages inside the cached prefix cost only $0.50/MTok to re-read — pruning them saves $0.50/MTok per token removed but can break the cache prefix for everything after, costing $5/MTok for the miss on subsequent content. Net effect could be negative.

**Approach:** When `insertBreakpoints` is active (explicit-cache provider), skip pruning messages that precede the last surviving cache breakpoint. Only prune in the "fresh" tail after the final breakpoint.

**Expected outcome:** Slightly higher token count per request but better cache hit rate on subsequent requests, leading to lower net cost over a session.

---

## Idea C: Tool-def compression / cost attribution

**Status:** In progress

**Hypothesis:** Tool definitions account for ~980K tokens resent across 85 requests in the benchmark. They're cached (free at $0.50/MTok read rate) but contribute to wire transfer time and context window pressure. Track this as a metric; optionally compress after first send.

**Approach:** Add a `toolDefTokens` metric to the optimize layer that tracks how many tokens are spent on tool definitions per turn. Surface this in `aap export` and the simulator. Consider a `compressToolDefs` strategy that sends full defs on turn 1, then a hash-stub on subsequent turns (only viable when the proxy can intercept and re-expand before forwarding — complex, may defer).

---

## Idea D: Volatile content reordering

**Status:** In progress

**Hypothesis:** Claude Code injects `<system-reminder>` blocks (current date, deferred tools list, git status, skill context) into user messages. These change between turns and can break prefix-match for everything after them. If volatile content is moved to the final user message (past the last breakpoint), the stable prefix above remains cache-eligible.

**Approach:** Detect `<system-reminder>` blocks in non-final user messages. Move them to the final user message (or strip and re-inject at the end). This preserves byte-identity of the cached prefix across turns.

**Risk:** Changing message content ordering could confuse the model or change behavior. Needs careful validation.

---

## Idea E: Cost attribution per strategy

**Status:** In progress

**Hypothesis:** A strategy that saves 1000 tokens but breaks 50K tokens of cache actually costs money. We need net-cost modeling, not just token-saved counts.

**Approach:** Extend the simulator's cache-cost model to attribute cache breaks to specific strategy actions. For each action, compute: (tokens_saved × miss_rate) minus (cache_tokens_broken × (miss_rate - hit_rate)). Report net savings per strategy.

---

## Findings log

- 2026-07-11: Claude Code places 4 cache_control markers per request (Bedrock sessions show 99-100% hit rate with no proxy intervention)
- 2026-07-11: Naive breakpoint insertion exceeded Anthropic's 4-marker cap → 400 error. Fixed with strategic restore-after-destroy policy.
- 2026-07-11: opt-nobreak (full optimize, no breakpoints) achieved 99.7% cache hit and $0.47 cost — best result. Suggests breakpoints add no value for Claude Code.
- 2026-07-11: Per-request uncached tokens: baseline 10 tok/req, optimize 9 tok/req — nearly identical, confirming Claude Code's built-in caching is already optimal.
- 2026-07-11: Model used was Opus 4.6 (not 4.8 as initially assumed) — user's default ANTHROPIC_DEFAULT_OPUS_MODEL setting.
