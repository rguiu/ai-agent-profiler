# iterative-fix-plus

A task-scheduler system with 7 modules and 9 planted bugs (8 in source +
3 unimplemented method stubs = 11 things to fix). Designed to force an agent
through deep read-fix-verify cycles across a realistic dependency graph.

## Planted bugs

| # | Module | Bug |
|---|--------|-----|
| 1 | `priority-queue.js` | `#bubbleUp` parent index: `Math.floor(i/2)` → should be `Math.floor((i-1)/2)` |
| 2 | `scheduler.js` | Inverted dependency check: blocks if ANY dep is complete, should block if ANY dep is NOT complete |
| 3 | `scheduler.js` | Retry uses `task.attempts` as priority (loses original `task.priority`) |
| 4 | `event-bus.js` | History trimming keeps oldest events, drops newest (reversed) |
| 6 | `result-cache.js` | `get()` returns entry metadata object instead of `entry.value` |
| 7 | `result-cache.js` | `#evictLRU` evicts most-recently-used instead of least-recently-used |
| 8 | `pipeline.js` | Stage results overwrite previous context entirely instead of merging |
| 9 | `throttle.js` | `SlidingWindowThrottle` uses `>` instead of `>=` for window boundary (rate-limit bypass) |

## Stubbed methods

| Method | File |
|--------|------|
| `PriorityQueue.merge(other)` | `src/priority-queue.js` |
| `RateLimiter.peekWait(n=1)` | `src/rate-limiter.js` |
| `ResultCache.topKeys(n)` | `src/result-cache.js` |

All three throw `"not implemented"`. The agent must implement them to satisfy their
JSDoc contracts.

## Test suite

The visible test directory (`test/`) contains 7 test suites with ~54 tests.
The hidden reference directory (`benchmarks/reference/iterative-fix-plus/`) contains
3 additional test suites that are copied into the scratch dir at verify time only —
the agent never sees them:

| File | What it covers |
|------|----------------|
| `methods.test.js` | Correctness of the 3 stubbed methods |
| `edge-cases.test.js` | Partial/wrong fixes for bugs #1-8, plus merge/peekWait/topKeys edge cases |
| `throttle-edge.test.js` | Window boundary condition (BUG #9), state consistency, burst handling |

The verify command is:
```
cp "$AAP_BENCH_REF"/*.test.js test/ && node --test test/*.test.js
```

## Benchmark run

```bash
./benchmarks/run.sh opencode --fixture iterative-fix-plus --tag base001 --save-artifacts
```

This creates a single session with all metrics, test results, and agent-produced
file snapshots under `benchmarks/runs/base001/`.
