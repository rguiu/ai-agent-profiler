# Benchmark Report: Optimize Layer (iterative-fix fixture) — OpenCode

**Date:** 2026-07-08
**Fixture:** `iterative-fix` — 6 modules, 7 planted bugs, 48 tests (8 failing)
**Agent:** OpenCode (DeepSeek v4 Pro)
**Task:** Fix all bugs iteratively until all tests pass

## Runs

| Run         | Description                                          |
| ----------- | ---------------------------------------------------- |
| baselineOC  | No optimizer — vanilla proxy passthrough             |
| optimizeOC2 | Optimize layer v1 (pruneStale, dedup, stablePrefix…) |
| optimizeOC3 | Optimize layer v2 (v1 + pruneUnusedTools + throttle) |

## Results

```
                   baselineOC/fix-all-bugs  optimizeOC2/fix-all-bugs  optimizeOC3/fix-all-bugs
  ────────────────────────────────────────────────────────────────────────────────────────────
  Requests                              38                        19                        18
  Total input                    2,878,660                   820,652                   636,125
    ↳ cached                     1,418,880                   410,048                   317,760
    ↳ uncached                   1,459,780                   410,604                   318,365
  Cache hit rate                       49%                       50%                       50%
  Output tokens                     20,134                     4,776                     3,812
  Cost                             $1.2697                   $0.3611                   $0.2800
  Tool calls                            48                        27                        24
  Distinct tools                         6                         4                         3
  Result tokens                    ~22,591                    ~9,998                   ~10,451
  Tool-def resent                 ~195,767                   ~95,238                   ~89,947
  Wall time                         391.9s                    280.0s                    408.0s
```

## Key Findings

| Metric             | Baseline | Optimize v1 | Optimize v2 | v2 vs Baseline | v2 vs v1 |
| ------------------ | -------- | ----------- | ----------- | -------------- | -------- |
| Cost               | $1.27    | $0.36       | $0.28       | **-78%**       | **-22%** |
| Total input tokens | 2.88M    | 821K        | 636K        | **-78%**       | **-22%** |
| Per-request input  | 75.8K    | 43.2K       | 35.3K       | **-53%**       | **-18%** |
| Requests           | 38       | 19          | 18          | **-53%**       | -5%      |
| Wall time          | 6m 32s   | 4m 40s      | 6m 48s      | +4%            | +46%     |
| Bugs found         | 7        | 8           | 8           | +1             | =        |
| Task success       | ✓ pass   | ✓ pass      | ✓ pass      | =              | =        |

## Cross-Agent Comparison

Optimized columns use the v2 optimize layer (v1 + `pruneUnusedTools` + `throttle`).

| Metric        | Claude (baseline) | Claude (optimized v2) | OpenCode (baseline) | OpenCode (optimized v2) |
| ------------- | ----------------- | --------------------- | ------------------- | ----------------------- |
| Requests      | 48                | 68                    | 38                  | 18                      |
| Total input   | 1.83M             | 329K                  | 2.88M               | 636K                    |
| Output tokens | 1,748             | 2,435                 | 20,134              | 3,812                   |
| Cost          | $2.88             | $0.68                 | $1.27               | $0.28                   |
| Wall time     | 18m 14s           | 17m 43s               | 6m 32s              | 6m 48s                  |
| Tool calls    | 32                | 43                    | 48                  | 24                      |
| Bugs found    | 7                 | 9                     | 7                   | 8                       |

## Bugs Found

The fixture contains 7 planted bugs. The optimized runs also surfaced additional edge cases
that were not explicitly planted but affected correctness under certain conditions.

| #   | Bug (file:line)                                                      | Claude baseline | Claude optimized | OpenCode baseline | OpenCode optimized |
| --- | -------------------------------------------------------------------- | :-------------: | :--------------: | :---------------: | :----------------: |
| 1   | PriorityQueue `#bubbleUp` parent calc (`priority-queue.js`)          |        ✓        |        ✓         |         ✓         |         ✓          |
| 2   | Scheduler dependency check inversion (`scheduler.js`)                |        ✓        |        ✓         |         ✓         |         ✓          |
| 3   | Scheduler retry uses wrong priority (`scheduler.js`)                 |        ✓        |        ✓         |         ✓         |         ✓          |
| 4   | EventBus history trims oldest instead of newest (`event-bus.js`)     |        ✓        |        ✓         |         ✓         |         ✓          |
| 5   | ResultCache `get()` returns entry wrapper (`result-cache.js`)        |        ✓        |        ✓         |         ✓         |         ✓          |
| 6   | ResultCache `evictLRU` evicts MRU (`result-cache.js`)                |        ✓        |        ✓         |         ✓         |         ✓          |
| 7   | Pipeline stage overwrites context instead of merging (`pipeline.js`) |        ✓        |        ✓         |         ✓         |         ✓          |
| 8   | `Date.now()` monotonic counter for LRU tie-breaking                  |        —        |        ✓         |         —         |         —          |
| 9   | Scheduler starvation / `#scheduleReady` deadlock                     |        —        |        ✓         |         —         |         ✓          |
|     | **Total**                                                            |      **7**      |      **9**       |       **7**       |       **8**        |

Both agents found all 7 planted bugs regardless of optimization. The optimized runs
uncovered additional issues:

- **Claude optimized (+2):** `Date.now()` monotonic counter (LRU eviction could mis-evict
  when two entries had the same millisecond timestamp) and scheduling starvation (tasks
  could be blocked indefinitely).
- **OpenCode optimized (+1):** Scheduler `#scheduleReady` deadlock — a `break` in the
  scheduling loop caused the agent to block on the first non-ready task, never scheduling
  tasks that came after it. In the baseline run this was masked by the agent's different
  traversal order; the cleaner optimized context exposed the edge case.

Neither agent found all 9 issues across all runs. Claude's optimized run found the
`Date.now()` counter issue that OpenCode missed; OpenCode's optimized run found the
scheduler deadlock that Claude also found (described as "scheduling starvation"). The two
scheduler findings are likely the same root cause described differently.

## Analysis

### Why cost dropped 78%

The optimizer cuts cost through three compounding effects: (1) reducing total input tokens via stale-result pruning (`pruneStale`), (2) removing unused tool definitions after the agent settles on its working set (`pruneUnusedTools`), and (3) more than halving the number of requests. With DeepSeek's $0.435/M input rate, each pruned token directly reduces cost. The baseline spent ~$1.25 on input alone; the v2 run spent ~$0.28. Output tokens (priced at $0.87/M) are a rounding error at this scale.

The v2 layer adds `pruneUnusedTools` on top of v1: this fixture's baseline exposed 6 distinct tools, but the v2 run converged on 3. Once the agent has stopped calling the others, their definitions are dropped from every subsequent request — trimming input from 821K (v1) to 636K (v2), a further 22%.

### Why the optimized run made FEWER requests

This is the key behavioral difference from Claude. Claude's optimized run made _more_ requests (68 vs 48) — it found additional edge cases and did extra verification work. OpenCode's optimized run made _fewer_ requests (18 vs 38) — the pruned context gave the model a cleaner view of what still needed fixing, allowing it to batch edits more efficiently and avoid redundant read/verify cycles.

### Why wall time is roughly flat

Unlike v1 (which finished 29% faster), the v2 run landed within ~4% of the baseline (6m 48s vs 6m 32s). The request count barely moved from v1 (18 vs 19), so the per-request savings from a smaller payload were offset by the model spending more time reasoning per turn on a denser, more focused context. Wall time on this fixture is dominated by agent path length, not payload size — a pattern also seen in the Claude v2 run.

### Request efficiency

The baseline averaged **1.26 tool calls per request** (48 calls / 38 requests), while the v2 run averaged **1.33 tool calls per request** (24 calls / 18 requests). With stale results removed, the model could pack more useful work into each turn instead of re-reading already-fixed files.

### Token breakdown (v2 vs baseline)

- **Total input -78%**: `pruneStale` replaces old tool results (>6 turns) with 1-line summaries; `pruneUnusedTools` removes definitions for tools no longer in use. Together they keep each request compact regardless of session length.
- **Output tokens -81%**: Less than half the requests (18 vs 38) naturally produces less output, and cleaner context yields more targeted edits with less explanatory text.
- **Result tokens -54%**: Fewer tool calls → less tool output ingested into context.
- **Tool-def resent -54%**: Fewer requests plus `pruneUnusedTools` → far less tool-definition overhead.

## Optimization Strategies Active (v2)

| Strategy           | Effect                                                   |
| ------------------ | -------------------------------------------------------- |
| `pruneStale`       | Replace tool results >6 turns old with compact summaries |
| `pruneUnusedTools` | Strip definitions for tools never called after N turns   |
| `dedup`            | Return stub for identical repeated tool calls            |
| `suppressReread`   | Suppress reads of files written <2 turns ago             |
| `stablePrefix`     | Canonicalise tool definitions for prompt-cache stability |
| `collapseSystem`   | Collapse repeated system prompts to hash stub            |
| `truncate`         | Head+tail for results >4KB                               |
| `throttle`         | Async semaphore (8 concurrent, 64 queued, 180s timeout)  |

## Configuration Used

```toml
[optimize]
enabled = true
pruneAfterTurns = 6
suppressWithinTurns = 2
truncateThreshold = 4096
pruneUnusedTools = true
pruneUnusedToolsAfter = 10

[throttle]
maxConcurrent = 8
maxQueued = 64
timeoutMs = 180000
```

## Conclusion

The v2 optimize layer delivers a **78% cost reduction** on OpenCode with DeepSeek v4 Pro,
while maintaining 100% task success — from $1.27 to $0.28 for the same task. The dominant
effects are `pruneStale` (preventing unbounded context growth) and `pruneUnusedTools`
(removing definitions for the ~3 tools the agent stopped using), combined with a behavioral
shift where the model made fewer, more efficient requests (~53% reduction).

Compared to Claude Code on Bedrock ($2.88 → $0.68, -77%), the two agents land at nearly the
same percentage reduction. The absolute cost is lower on OpenCode ($0.28 vs $0.68),
reflecting DeepSeek's lower per-token pricing. Wall time on this fixture is dominated by
agent path length rather than payload size, so it stays roughly flat under v2 on both agents.

For short sessions (<10 requests), the optimizer has minimal effect. The sweet spot is
sessions with 20+ requests involving repeated file reads and iterative fix/verify cycles.
