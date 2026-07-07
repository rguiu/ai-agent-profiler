# Benchmark Report: Optimize Layer (iterative-fix fixture) — OpenCode

**Date:** 2026-07-07
**Fixture:** `iterative-fix` — 6 modules, 7 planted bugs, 48 tests (8 failing)
**Agent:** OpenCode (DeepSeek v4 Pro)
**Task:** Fix all bugs iteratively until all tests pass

## Results

```
                   baselineOC/fix-all-bugs  optimizeOC2/fix-all-bugs      Δ
  ──────────────────────────────────────────────────────────────────────────
  Requests                              38                        19   -50%
  Total input                    2,878,660                   820,652   -71%
    ↳ cached                     1,418,880                   410,048   -71%
    ↳ uncached                   1,459,780                   410,604   -72%
  Cache hit rate                       49%                       50%    +1%
  Output tokens                     20,134                     4,776   -76%
  Cost                             $1.2697                   $0.3611   -72%
  Tool calls                            48                        27   -44%
  Distinct tools                         6                         4   -33%
  Result tokens                    ~22,591                    ~9,998   -56%
  Tool-def resent                 ~195,767                   ~95,238   -51%
  Wall time                         391.9s                    280.0s   -29%
```

## Key Findings

| Metric             | Baseline | Optimized | Improvement |
| ------------------ | -------- | --------- | ----------- |
| Cost               | $1.27    | $0.36     | **-72%**    |
| Total input tokens | 2.88M    | 821K      | **-71%**    |
| Requests           | 38       | 19        | **-50%**    |
| Wall time          | 6m 32s   | 4m 40s    | **-29%**    |
| Bugs found         | 7        | 8         | +1          |
| Task success       | ✓        | ✓         | Both pass   |
| Verify             | pass     | pass      | Both pass   |

## Cross-Agent Comparison

| Metric        | Claude (baseline) | Claude (optimized) | OpenCode (baseline) | OpenCode (optimized) |
| ------------- | ----------------- | ------------------ | ------------------- | -------------------- |
| Requests      | 48                | 52                 | 38                  | 19                   |
| Total input   | 1.83M             | 502K               | 2.88M               | 821K                 |
| Output tokens | 1,748             | 3,204              | 20,134              | 4,776                |
| Cost          | $2.88             | $0.99              | $1.27               | $0.36                |
| Wall time     | 18m 14s           | 13m 39s            | 6m 32s              | 4m 40s               |
| Tool calls    | 32                | 41                 | 48                  | 27                   |
| Bugs found    | 7                 | 9                  | 7                   | 8                    |

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

### Why cost dropped 72%

The optimizer cuts cost through two compounding effects: (1) reducing total input tokens by 71% via stale-result pruning, and (2) halving the number of requests. With DeepSeek's $0.435/M input rate, each pruned token directly reduces cost. The baseline spent $1.25 on input alone; the optimized run spent $0.36 on input. Output tokens (priced at $0.87/M) are a rounding error at this scale.

### Why the optimized run made FEWER requests

This is the key behavioral difference from Claude. Claude's optimized run made _more_ requests (52 vs 48) — it found additional edge cases and did extra verification work. OpenCode's optimized run made _fewer_ requests (19 vs 38) — the pruned context gave the model a cleaner view of what still needed fixing, allowing it to batch edits more efficiently and avoid redundant read/verify cycles. Fewer requests means lower output-token cost and less wall time spent waiting on I/O.

### Why wall time improved 29%

Two drivers:

1. **Fewer requests (-50%)** — each request incurs a network round-trip + LLM inference time. Cutting requests in half directly reduces total wait time.
2. **Smaller payload (-71% input)** — less data to transmit and process per request. However, optimized requests averaged 14.7s vs 10.3s for the baseline, suggesting the model spent more time reasoning per turn with a cleaner, more focused context.

### Request efficiency

The baseline averaged **1.26 tool calls per request** (48 calls / 38 requests), while the optimized run averaged **1.42 tool calls per request** (27 calls / 19 requests). With stale results removed, the model could pack more useful work into each turn instead of re-reading already-fixed files.

### Token breakdown

- **Total input -71%**: The `pruneStale` strategy replaces old tool results (>6 turns) with 1-line summaries. In a 19-38 request session, this prevents early-turn results from bloating every subsequent request.
- **Output tokens -76%**: Half the requests (19 vs 38) naturally produces less output. Additionally, with cleaner context, the model produced more targeted edits with less explanatory text.
- **Result tokens -56%**: Fewer tool calls → less tool output ingested into context.
- **Tool-def resent -51%**: Fewer requests → fewer opportunities to re-send tool definitions.

## Optimization Strategies Active

| Strategy         | Effect                                                   |
| ---------------- | -------------------------------------------------------- |
| `pruneStale`     | Replace tool results >6 turns old with compact summaries |
| `dedup`          | Return stub for identical repeated tool calls            |
| `suppressReread` | Suppress reads of files written <2 turns ago             |
| `stablePrefix`   | Canonicalise tool definitions for prompt-cache stability |
| `collapseSystem` | Collapse repeated system prompts to hash stub            |
| `truncate`       | Head+tail for results >4KB                               |

## Configuration Used

```toml
[optimize]
enabled = true
pruneAfterTurns = 6
suppressWithinTurns = 2
truncateThreshold = 4096
```

## Conclusion

The optimize layer delivers a **72% cost reduction** and **29% speed improvement** on
OpenCode with DeepSeek v4 Pro, while maintaining 100% task success. The dominant effect is
`pruneStale` reducing total input tokens by 71%, combined with a behavioral shift where the
model made fewer, more efficient requests (~50% reduction).

Compared to Claude Code on Bedrock (66% cost reduction, 25% speed improvement), the
optimizer is _more_ effective on OpenCode + DeepSeek — largely because OpenCode's baseline
generated twice the input tokens per session (2.88M vs 1.83M), giving the pruner more waste
to eliminate. The absolute cost is also lower: $0.36 for the optimized OpenCode run vs $0.99
for the optimized Claude run, reflecting DeepSeek's lower per-token pricing.

For short sessions (<10 requests), the optimizer has minimal effect. The sweet spot is
sessions with 20+ requests involving repeated file reads and iterative fix/verify cycles.
