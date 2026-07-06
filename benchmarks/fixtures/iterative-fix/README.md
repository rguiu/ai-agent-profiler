# iterative-fix

A task scheduler system with 6 modules and 7 planted bugs designed to force
~35-40 LLM requests through iterative read-fix-verify cycles.

48 tests total, 8 failing (one bug causes multiple test failures).

## Bugs

| #   | Module            | Nature                                      | Tests broken    |
| --- | ----------------- | ------------------------------------------- | --------------- |
| 1   | priority-queue.js | Wrong parent index in bubbleUp              | 1               |
| 2   | scheduler.js      | Inverted dependency check logic             | 1               |
| 3   | scheduler.js      | Retry uses attempt count as priority        | 1               |
| 4   | event-bus.js      | History trimming keeps oldest, drops newest | 1               |
| 5   | result-cache.js   | get() returns metadata object, not value    | 4               |
| 6   | result-cache.js   | Eviction removes MRU instead of LRU         | (covered by #5) |
| 7   | pipeline.js       | Context overwrite instead of merge          | 1               |

## Why ~40 requests

The single `fix-all-bugs` task forces:

- Initial test run + reading output (2-3 requests)
- Per bug: read source, reason, edit, re-test (4-5 requests × 7 bugs = 28-35)
- Cross-file tracing for scheduler deps (2-3 extra)
- Final verification (1-2 requests)

This makes `pruneStale`, `suppressReread`, and `dedup` highly relevant:

- Agent re-reads source files multiple times across the session
- Agent re-runs `node --test` after each fix (dedup fires on unchanged test output)
- Old tool results accumulate in context across 30+ turns (pruneStale fires)
- Agent reads files it just edited to verify changes (suppressReread fires)
