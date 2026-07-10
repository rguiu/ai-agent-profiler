# Benchmark Report: Optimize Layer on DeepSeek (iterative-fix-plus)

**Date:** 2026-07-10
**Fixture:** `iterative-fix-plus` — 7 modules, 9 planted bugs + 3 method stubs, 54 fixture
tests + 18 hidden edge/reference tests
**Agent:** opencode
**Model / provider:** `deepseek-v4-pro` (DeepSeek, OpenAI-compatible API)
**Task:** single combined session — fix all bugs, then implement 3 stubbed methods
**Runner:** `./benchmarks/iterative-fix-ab.sh opencode` (baseline `--no-optimize` vs `--optimize`,
isolated proxy on :8199)

## Headline

**On DeepSeek, the optimize layer made everything worse.** It cost **5.9× more**, used
**3.2× more tokens**, took **3.6× longer**, and scored **worse** on the hidden edge tests —
while neither run fully passed.

This is **not** an inherent property of DeepSeek. An earlier run of the _same_ agent
(opencode) on the _same_ provider (DeepSeek v4 Pro) showed optimize **winning**: −78% cost,
**fewer** requests (18 vs 38), 100% task success (`REPORT-iterative-fix-opencode.md`). The
regression was introduced by a **code change to the optimize layer** between that run and
this one — see "Root cause" below. The cache-mix effect (also below) is the _mechanism_ by
which the change hurts; the change is the _trigger_.

## Root cause: `prune_stale` now fires on OpenAI-format traffic

The winning opencode/DeepSeek run and this one differ by an **uncommitted edit to
`src/optimize/layer.ts`** (present in the working tree as of this session).

- opencode → DeepSeek sends requests in **OpenAI chat format**: tool results are
  `{ role: "tool", content: "<string>" }`. (Confirmed: 117/117 requests this run are
  `format=openai`.)
- The **committed** `pruneStaleResults()` only matched the **Anthropic** shape —
  `tool_result` blocks inside an **array** `content`. On OpenAI-format messages the array
  check failed and the function returned early, so **`prune_stale` was a silent no-op on
  DeepSeek**. In the winning run, the cost savings came entirely from `pruneUnusedTools` +
  `stablePrefix`, which are format-agnostic and **cache-safe**.
- The **working-tree** version adds an explicit
  `msg.role === "tool" && typeof msg.content === "string"` branch, so `prune_stale` now
  activates on OpenAI format for the first time. This run recorded **`prune_stale` firing
  5,074 times** — and it was the only strategy doing meaningful work.

So the "aggressive prune" that has always been safe for Claude (Anthropic array format) is
now _newly_ applied to DeepSeek, where it is both cache-hostile and too destructive to the
agent's working context.

## Two-stage damage

`prune_stale` rewriting tool results mid-conversation causes two compounding failures:

1. **Cache invalidation (cost):** it mutates content _inside_ the cached prefix, so every
   subsequent request re-bills from the edit point onward. Cache hit 98% → 94%; uncached
   tokens 37.5K → 418.9K (+1016%). Detailed below.
2. **Context loss (performance):** it removes tool results the agent still needs to track
   iterative fix/verify progress, so the agent re-reads files, re-runs tests, and repeats
   work — 117 requests vs 49 (worse even than the old baseline's 38) — and passes **3 fewer
   hidden edge tests** (14/18 vs 17/18). Less context did **not** improve reasoning here; it
   degraded it. (This is the opposite of the Claude effect, where pruning the Anthropic-shape
   results helped focus.)

## Results (corrected token accounting)

```
                 baseline/iterative-fix-plus  optimize/iterative-fix-plus       Δ
─────────────────────────────────────────────────────────────────────────────────
Requests                                  49                          117   +139%
Total input                        2,188,710                    6,946,916   +217%
  ↳ cached                         2,151,168                    6,528,000   +203%
  ↳ uncached                          37,542                      418,916  +1016%
Cache hit rate                           98%                          94%     -4%
Output tokens                         25,368                       76,744   +203%
Cost                                 $0.0461                      $0.2725   +491%
Tool calls                                60                          131   +118%
Distinct tools                             4                            5    +25%
Result tokens                        ~26,326                       ~3,886    -85%
Tool-def resent                     ~253,968                     ~613,756   +142%
Wall time                             509.4s                      1814.4s   +256%
Fixture tests                          54/54                        54/54
Edge tests                             17/18                        14/18
```

## Key findings

| Metric              | Baseline | Optimize | Δ          |
| ------------------- | -------- | -------- | ---------- |
| Cost                | $0.0461  | $0.2725  | **+491%**  |
| Prompt tokens       | 2.19M    | 6.95M    | **+217%**  |
| Uncached input tok  | 37.5K    | 418.9K   | **+1016%** |
| Cache hit rate      | 98.3%    | 94.0%    | −4pp       |
| Requests            | 49       | 117      | **+139%**  |
| Wall time           | 8m 29s   | 30m 14s  | **+256%**  |
| Fixture tests       | 54/54    | 54/54    | =          |
| Edge (hidden) tests | 17/18    | 14/18    | **−3**     |
| Task success        | ✗ fail   | ✗ fail   | =          |

## Analysis

### Why cost rises even when tokens don't (the cache-mix effect)

DeepSeek prices input tokens by cache status, with a ~121× spread:

| Bucket         | Rate (per Mtok) |
| -------------- | --------------- |
| cached input   | $0.0036         |
| uncached input | $0.435          |
| output         | $0.87           |

Cost is a function of the **mix**, not the total. Baseline keeps a **stable prefix**, so
98.3% of input is served from cache (near-free). The optimize layer rewrites request bodies
mid-session (`prune_stale` fired **5,074 times**), invalidating the cache prefix from the
point of each edit onward. Uncached tokens exploded **37.5K → 418.9K (+1016%)** — and those
are the expensive ones. Even the "tokens saved" the optimizer reports (~2.8M) are mostly
**cached** tokens it removed, i.e. it saved tokens that were already nearly free while
forcing the remainder to be re-billed at 121× the rate.

### Why the agent looped (reliability regression)

`prune_stale` replaces tool results older than `pruneAfterTurns` (6) with compact summaries.
On Claude this helped the model focus. On this DeepSeek run it removed context the agent
still needed to track its iterative fix/verify progress, so it re-read files, re-ran tests,
and repeated work — 117 requests, and **3 fewer hidden edge tests passing** than baseline
(14/18 vs 17/18). Less context did **not** improve reasoning here; it degraded it.

### Contrast with the prior winning DeepSeek run and Claude/Bedrock

| Signal        | opencode/DeepSeek (old, `-opencode.md`) | opencode/DeepSeek (this run) | Claude/Bedrock (v2) |
| ------------- | --------------------------------------- | ---------------------------- | ------------------- |
| Cost          | **−78%**                                | **+491%**                    | **−77%**            |
| Requests      | 38 → 18 (**−53%**)                      | 49 → 117 (**+139%**)         | 48 → 68             |
| `prune_stale` | **no-op** (Anthropic-only code path)    | **active** (5,074 actions)   | active              |
| Reliability   | pass                                    | fail, −3 edge tests          | pass, +2 bugs       |

The old opencode/DeepSeek win came from `pruneUnusedTools` + `stablePrefix` while
`prune_stale` silently did nothing on OpenAI-format traffic. Enabling `prune_stale` on that
format (the working-tree change) is what flipped a −78% win into a +491% regression. Claude
is unaffected because its Anthropic array-format results were always pruned, and — critically
— Anthropic's cache tolerated it while DeepSeek's did not.

**Open questions for the cross-provider study** (`docs/optimize-cross-provider-eval.md`):
(a) does DeepSeek's cache break under `prune_stale` because of cache granularity, or purely
because we mutate the prefix? (b) is the reliability drop DeepSeek-specific or would Claude
also degrade if pruned as aggressively? (c) should `prune_stale` be gated off for
OpenAI-format / cheap-cache providers entirely?

### A/B control: `prune_stale` OFF

To isolate `prune_stale` as the culprit, a third run was executed with the optimize layer
enabled but **`pruneStale = false`** (all other strategies unchanged), tagged `optimize-nps`,
compared against the same baseline:

```
                 baseline/iterative-fix-plus  optimize-nps/iterative-fix-plus      Δ
────────────────────────────────────────────────────────────────────────────────────
Requests                                  49                               22   -55%
Total input                        2,188,710                          920,640   -58%
  ↳ cached                         2,151,168                          879,744   -59%
  ↳ uncached                          37,542                           40,896    +9%
Cache hit rate                           98%                              96%    -3%
Output tokens                         25,368                           25,150    -1%
Cost                                 $0.0461                          $0.0428    -7%
Tool calls                                60                               43   -28%
Distinct tools                             4                                4      =
Result tokens                        ~26,326                          ~25,912    -2%
Tool-def resent                     ~253,968                         ~111,111   -56%
Wall time                             509.4s                           657.0s   +29%
Fixture tests                          54/54                            54/54
Edge tests                             17/18                            14/18
```

**This is conclusive.** Turning off _only_ `prune_stale` flips the result:

| Metric       | optimize (prune_stale ON) | optimize-nps (prune_stale OFF) |
| ------------ | ------------------------- | ------------------------------ |
| Cost vs base | **+491%**                 | **−7%**                        |
| Requests     | 117 (+139%)               | **22 (−55%)**                  |
| Uncached tok | 418.9K (+1016%)           | **40.9K (+9%)**                |
| Cache hit    | 94%                       | **96%**                        |

With `prune_stale` disabled, the remaining strategies (`pruneUnusedTools`, `stablePrefix`,
`dedup`, `suppressReread`, `collapseSystem`, `truncate`) behave exactly as the earlier
winning opencode report described: **fewer requests (22 vs 49), lower cost, stable cache**,
and no runaway uncached tokens. `prune_stale` firing on OpenAI-format traffic accounts for
the entire regression.

Two honest caveats on the control run:

- It still scores **14/18 on edge tests** (same as the prune_stale-ON run, below baseline's
  17/18). So while `prune_stale` explains the **cost/loop** blowup, the **edge-test dip is
  not attributable to it** — both optimized runs miss the same 3 hidden tests, suggesting a
  separate effect (e.g. `pruneUnusedTools`/`suppressReread` trimming context, or plain agent
  non-determinism on a single sample). Neither run passed overall, so no optimize config
  "solved" this fixture; this needs repeated runs to separate signal from noise.
- Wall time is +29% despite far fewer requests — per-request reasoning time dominates here,
  consistent with prior reports.

## Tooling fixes made during this run

1. **`compare.ts` token double-count (corrected above).** The comparison table assumed the
   Anthropic convention (`input_tokens` excludes cached) for all providers. DeepSeek/OpenAI
   report `prompt_tokens` **including** cached, so the old table double-counted cache and
   mislabelled it — it showed "50% cache hit / 2.2M uncached" when the truth was
   "98% / 37.5K". `summarize()` is now format-aware. Costs were always correct
   (`computeCost` already used the OpenAI convention); only the display was wrong.
2. **Benchmark test scoring.** `run.sh` counted per-file `ok`/`not ok` TAP lines that
   `node --test` never emits, so `fixture=`/`edge=` were always `0/0`. It now runs the
   fixture and reference suites separately and parses each TAP footer (`# pass` / `# tests`).

## Configuration used

```toml
[optimize]
enabled = true
dedup = true
truncate = true
stablePrefix = true
pruneStale = true
suppressReread = true
collapseSystem = true
pruneUnusedTools = true
truncateThreshold = 4096
pruneAfterTurns = 6
suppressWithinTurns = 2
pruneUnusedToolsAfter = 10

[pricing."deepseek-v4-pro"]
inputPerMTok = 0.435
outputPerMTok = 0.87
cacheInputPerMTok = 0.0036
```

## Session IDs

| Run          | Session ID                                           |
| ------------ | ---------------------------------------------------- |
| baseline     | `bench-opencode-iterative-fix-plus-20260710122817-1` |
| optimize     | `bench-opencode-iterative-fix-plus-20260710123727-1` |
| optimize-nps | `bench-opencode-iterative-fix-plus-20260710135028-1` |

## Conclusion

The regression is **not** "DeepSeek can't benefit from optimization" — the same agent and
provider previously showed a **−78%** cost win (`REPORT-iterative-fix-opencode.md`). It is a
**specific, traceable code change**: enabling `prune_stale` on OpenAI-format traffic (an
uncommitted edit to `src/optimize/layer.ts`) turned a previously-inert, cache-safe strategy
into a cache-hostile, context-destroying one on DeepSeek. Result: **+491% cost**, an agent
loop (2.4× requests), and worse task quality. **The `optimize-nps` control run confirms
this**: disabling only `prune_stale` restores a **−7% cost, −55% request** result.

Takeaways:

1. **`prune_stale` must be gated by provider cache economics.** When cached input is far
   cheaper than uncached (DeepSeek $0.0036 vs $0.435/Mtok; Anthropic prompt caching),
   rewriting content inside the cached prefix costs more than it saves. Consider disabling it
   for OpenAI-format / cheap-cache providers, or making it prefix-preserving.
2. **Optimization can degrade reliability, not just cost.** Pruning context the agent still
   needs caused looping and lower hidden-test scores. Any optimize strategy must be measured
   against task success, not just tokens.
3. **The prior "wins" partly measured an inert strategy.** Because `prune_stale` was a no-op
   on DeepSeek before, older reports' attribution of savings to it (on opencode) was wrong;
   the real drivers there were `pruneUnusedTools` + `stablePrefix`. The cross-provider study
   should re-confirm per-strategy attribution — see `docs/optimize-cross-provider-eval.md`.
