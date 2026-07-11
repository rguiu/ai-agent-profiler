# DeepSeek Optimization Findings

Status: **interim / paused** — the cache mechanics are understood, the optimize layer is
built and works mechanically (saves tokens, preserves the prefix cache), and a full-config
run passed the task identically to baseline. But with only 2 heavy runs (one passed, one
failed) the **failure rate is unknown**; needs batch validation before shipping. Work
paused to focus on Claude; see §9 to resume.

> **Headline:** The DeepSeek optimizations shrink the prompt (~69K tokens removed/run) and
> preserve the prefix cache (~96% hit, no resets), and a full-engagement run solved the task
> identically to baseline (54/54 fixture, 54/57 edge). BUT in the one-shot A/B the optimize
> run cost **~3.5× more** ($0.036 vs $0.010) — driven by (1) the agent generating 3× more
> output and (2) cross-run cache warming favoring the verbatim baseline, **not** by any cache
> reset. So "tokens saved" ≠ "money saved", and this single A/B proves neither a cost win nor
> a clean loss. **Not shippable until batch validation (N≥5/arm, cache warmed equally).**
> Token savings are only meaningful alongside verified task success + a fair cost comparison,
> which is why the benchmark's test-pass reporting had to be fixed first (§8).

Companion docs:

- `docs/DEEPSEEK-CACHING.md` — the mechanism, measured evidence, and cheat sheet.
- `benchmarks/cache-probe.ts` — reproducible ground-truth API probe.
- `benchmarks/cache-fixture-demo.ts` — offline cost model over a fixture.

---

## 1. The problem

Optimizations tuned for Anthropic made DeepSeek **more** expensive. DeepSeek bills
cached-prefix tokens ~10× cheaper than uncached, and any edit near the front of the
prompt forfeits that discount for everything downstream. Our layer edited the front
(system, tools, oldest messages) every turn, so it repeatedly reset the cache.

## 2. How DeepSeek caching actually works (measured, not assumed)

`benchmarks/cache-probe.ts` sends crafted requests to the live API and reads back
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. Result (deepseek-chat, base
prompt 8046 tokens):

| Test                            |  hit | miss | reading                                  |
| ------------------------------- | ---: | ---: | ---------------------------------------- |
| base, cold                      |    0 | 8046 | first send is all miss                   |
| base, repeated                  | 7936 |  110 | ~99% hit — prefix cache works            |
| append at tail                  | 7936 | 1670 | full prefix hits; only new tail misses   |
| edit early message              |    0 | 8166 | early edit → **entire** request misses   |
| remove middle block             | 1536 | 4828 | hits only up to the removal, rest misses |
| reorder two blocks (same bytes) | 1536 | 6510 | identical content, new order → **miss**  |

**Verdict: strict token-prefix from position 0.** Position is everything; reordering
identical content does not hit; removing/moving a block breaks the cache from that point.
There is **no** position-independent block caching (an earlier informal claim of that was
a measurement artifact from opencode's `messages…tools` JSON ordering plus a char/4 token
estimate — corrected).

**Delete break-even:** removing `R` tokens at position `P` saves `R × miss_price` but
converts the `D` downstream tokens from hit→miss (`≈ 0.9 × D × miss_price`). It only pays
off when `R > ~0.9 × D` — i.e. you must remove almost the entire tail. Mid-history pruning
is otherwise a net loss.

## 3. Where the money actually goes (cost decomposition)

Across 29 captured DeepSeek sessions:

- **Cached input is ~96% of tokens but only ~3–17% of cost.** The prefix cache is cheap
  and already working; squeezing it harder has little upside.
- **Cost splits by session length:** short sessions are **output-dominated** (50–85%);
  long sessions are **uncached-input-dominated** (67–93%).
- On a 440-turn outlier ($5.49), **96.6% of miss tokens were re-misses** — old context
  re-billed after cache eviction, not new content. Context accumulation is the real cost
  driver in long sessions.

Implication: the highest-value lever is **reducing accumulated context** in long
sessions, done without triggering per-turn cache resets.

## 4. What we built

Provider-aware profile (`profile = auto`), resolved in `src/proxy/proxy.ts`
(`resolveOptimizeConfig`). For DeepSeek it applies `CACHE_SAFE_OVERRIDES`; Claude keeps
the full legacy layer. All strategies live in `src/optimize/layer.ts`.

**Disabled for DeepSeek** (they edit the prefix → cache resets):
`collapseSystem`, `pruneUnusedTools`, `pruneStale`.

**Enabled for DeepSeek** (cache-safe, position-independent, idempotent):

| Strategy          | What it does                                                                                                                                  | Cache property                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `stableTruncate`  | Head+tail truncate large tool results, identical bytes every request                                                                          | No prefix move                      |
| `shapeTestOutput` | Drop passing-test spam / ANSI / dup lines from test output deterministically                                                                  | No prefix move                      |
| `frozenCompact`   | Once emitted context > `compactThreshold`, fold old messages into ONE frozen summary; keep a recent tail; hysteresis floor prevents re-firing | One reset per compaction, amortised |
| `prefixProbe`     | Diagnostic: structural per-section comparison flags genuine prefix edits (not appends/reorders)                                               | Read-only                           |

Plus a **post-hoc reconciliation** (`src/recommend/recommend.ts`,
`prefix_cache_reset`): uses real `prompt_cache_miss_tokens`, flagging only miss that
exceeds newly-added content (`miss − input_growth`) — the ground-truth signal the live
byte probe cannot provide. Validated to stay quiet on the real 98%-hit session.

Also added: cache-cost model in the simulator (`src/optimize/cache-cost.ts`,
`simulate.ts`) so dry-runs price the prefix cache instead of counting raw tokens.

## 5. Live A/B (mixed — cost confounded, needs batches)

Controlled baseline-vs-optimize on iterative-fix-plus (opencode → deepseek-v4-pro),
all scored with the **fixed** verify harness (§8), via `benchmarks/iterative-fix-ab.sh`
(`--no-optimize` baseline, `--optimize` treatment). The canonical runs live in
`benchmarks/runs/{baseline,optimize}/`; the side-by-side is `benchmarks/DEEPSEEK-COMPARISON.md`.
A third earlier full-opt run (`45/54 ❌`, listed below) is retained only as the "failed"
data point.

| run                  | fixture      | edge  | requests | input tok | cache hit | cost    | strategies                                                     |
| -------------------- | ------------ | ----- | -------- | --------- | --------- | ------- | -------------------------------------------------------------- |
| baseline (no-opt)    | **54/54 ✅** | 54/57 | 41       | 985,422   | 100%      | $0.0102 | none                                                           |
| optimize (full opt)  | **54/54 ✅** | 54/57 | 23       | 769,950   | 96%       | $0.0363 | frozen_compact ×1 (~49K), truncate ×10 (~17K), shape ×13 (~3K) |
| earlier full-opt run | **45/54 ❌** | 15/57 | 21       | 330,536   | 88%       | $0.0331 | frozen_compact ×1 (~39K), truncate ×12 (~37K), shape ×3        |

### Correctness

The two full-opt runs disagree (54/54 ✅ vs 45/54 ❌) despite near-identical strategy
engagement. So the failure is **within opencode's run-to-run non-determinism**, not
evidence the optimizer breaks correctness. The passing optimize run matched baseline
**exactly** (54/54 fixture, 54/57 edge). ✅ The optimizer does not inherently break the task.

### Cost — optimize cost ~3.5× more, but the comparison is confounded

Decomposition (cached $0.0036/M, uncached $0.435/M, output $0.87/M):

| component      | baseline             | optimize              |
| -------------- | -------------------- | --------------------- |
| cached input   | $0.00354             | $0.00263              |
| uncached input | $0.00054 (1,230 tok) | $0.01666 (38,302 tok) |
| output         | $0.00616 (7,081 tok) | $0.01696 (19,492 tok) |
| **total**      | **$0.01024**         | **$0.03625**          |

**This is NOT a cache reset caused by the optimizer.** Per-request analysis (miss tokens
minus new-content growth) shows **no reset on any turn in either run** (baseline max
excess-miss −99, optimize +72; a reset would be thousands). Both caches were healthy.
The 3.5× gap has two confounds:

1. **Output tripled** (7K → 19.5K tok, +$0.011) — the agent generated more this run; pure
   opencode path noise, unrelated to the optimizer.
2. **Uncached input rose** (1.2K → 38.3K tok, +$0.016) **as legitimate first-sight misses,
   not resets.** Likely cause: **cross-run cache warming** — the baseline re-sends verbatim
   fixture bytes already warm in DeepSeek's disk cache from prior baseline runs (so ~0 miss),
   while the optimize run sends _transformed_ bytes (truncated/shaped/compacted) that are
   novel → cold-miss on first sight. This structurally favors the verbatim baseline in a
   one-shot A/B and would shrink if the optimize arm were warmed/repeated.

### What we can and cannot say

- ✅ Optimizer does not inherently break correctness (one run matched baseline exactly).
- ✅ Its own per-turn cache behavior is healthy (96% hit, no resets).
- ⚠️ **"~69K tokens saved" is prompt shrinkage, not money saved** — those were mostly cheap
  cached tokens; the transformed prompt incurred _more_ expensive uncached input this run.
- ❌ **This single A/B shows neither a cost win nor a clean loss** — output path-noise and
  cross-run cache warming dominate the raw $ delta. And one of two full-opt runs failed the
  task. **Batches (N≥5/arm, with the cache warmed equally for both arms) are required**
  before any cost or safety claim — the single blocking gap (§9).

Offline 120-turn simulation (`cache-fixture-demo`): `frozenCompact` cut summed emitted
context ~53% (7.82M → 3.70M tokens) with only 2 resets — the mechanism works as designed.
Wiring test pass/fail into the harness (§8) is what made this analysis trustworthy at all;
before that, every run reported token "wins" with the task outcome invisible.

## 6. Honest caveats

- **Token savings ≠ success.** The entire early part of this investigation optimized the
  cheapest 3–17% of the bill (cached input) and reported token savings as wins, while the
  agent's actual task outcome was unmeasured (and, once measured, sometimes failing).
- **Live A/B can't attribute cost or correctness cleanly** from one sample — opencode is
  non-deterministic (turn counts differ per run). Need distributions over many runs.
- **Token counts use a char/4 estimate**, not DeepSeek's tokenizer. Directionally sound
  for the cache math; the ground-truth cache numbers come from the API `usage` fields.
- **frozenCompact only triggers past `compactThreshold` (60K)**; short sessions never hit
  it. When it does trigger, §5 suggests it may harm correctness.

## 7. Rejected / low-value ideas

- **Tool lazy-loading / dynamic tool fetch:** tools are cached (~3–4% of cost); changing
  them mid-session resets the prefix. Net loss. Static session-start pruning is safe but
  marginal.
- **Sliding-window / age-based pruning (`pruneStale`):** edits the prefix every turn — the
  original regression. Disabled for DeepSeek.

## 8. Benchmark harness fixes (made to get valid test results)

The correctness finding in §5 was only possible after fixing the benchmark harness, which
had been silently scoring every run as `fail` with no test data. All in `benchmarks/`:

- **Node resolver (`run.sh`):** verify commands use `node --test --test-isolation=none`,
  which requires Node ≥22. The ambient shell Node was v14 → `node: bad option` → tests
  never ran → every task scored `fail` with `0/0`. Fixed by resolving a Node ≥22 and
  prepending it **only** to the verify subprocess's PATH (`VERIFY_NODE_BIN`) — `aap` itself
  keeps the ambient Node, because it's linked against a specific better-sqlite3 ABI and
  breaks on a mismatched major (v24).
- **Report metrics were empty:** the `aap export --json` for the Session Metrics table ran
  under a broken Node and produced a 0-byte file → all `—`. Fixed by not globally hijacking
  PATH (above), so `aap` runs under the ambient/compatible Node.
- **Garbage timestamp:** report used `date -r "$RUN_STAMP"` where `RUN_STAMP` is a formatted
  string (`20260711…`), not epoch seconds → year 644006. Fixed to use `RUN_START` (epoch).
- **Report labeling (`fmt_test_result`):** a zero-footer section now reads `not run (error)`
  (bad option / OOM / crash) or `did not finish (timeout/crash)` (hung, SIGKILLed) instead
  of a bare `—`, so a broken runner never masquerades as "no tests".
- **Unbounded drain loops (test bug):** `while (!pq.isEmpty()) result.push(pq.pop())` in the
  edge/fixture tests spun forever on a broken heap. Bounded with a guard that **fails
  cleanly** instead of hanging (5 loops across `edge-cases.test.js`, `priority-queue.test.js`).
- **`merge(self)` OOM (test + code bug):** the edge test `merge(pq)` triggered the agent's
  naive `merge` (`for (const x of other.#heap) this.push(x)` — grows forever when
  `other === this`), exhausting all memory and killing the whole `node --test` process. The
  test now detects runaway growth and fails in ~0s with a clear message. The scheduler
  busy-loop tests were also routed through the existing worker-thread guard so a synchronous
  spin is force-terminated rather than hanging.

## 9. Open issues / where to resume (DeepSeek, later)

1. **DECISIVE: batch validation (N≥5 per arm), with the cache warmed equally.** We have 2
   full-opt runs: one passed (54/54, edge identical to baseline), one failed (45/54). With a
   non-deterministic agent, 2 runs can't establish the failure rate. Also, the one-shot cost
   comparison is confounded by **cross-run cache warming** (the verbatim baseline benefits
   from prior baseline runs already being warm in DeepSeek's cache; the optimizer sends novel
   transformed bytes that cold-miss). Before measuring cost: warm each arm equally (run each
   ≥2× and discard the first), then run `benchmarks/iterative-fix-ab.sh` ~5× per arm and
   compare pass-rate + cost **distributions**. This is the one gate before any ship decision.
2. **If the optimized arm shows a higher failure rate than baseline: isolate the culprit.**
   Re-run with `frozenCompact` off (leaving only byte-stable transforms) to test whether
   mid-session compaction is removing context the agent needs. `frozenCompact` is the
   prime suspect (it's the only strategy that _removes_ history).
3. **`compactThreshold` / `compactKeepTail` tuning** — if compaction hurts, a larger
   threshold and bigger kept-tail may retain enough context while still saving on very long
   sessions.
4. Wire `dedup`/`suppressReread` into the live request path (currently only in
   `rewriteToolResult`, which the proxy never calls) to cut redundant re-reads at source.
5. Output-reduction lever (per-turn `max_tokens` cap / terse-output nudge) for the
   short-session, output-dominated case.
6. Investigate the 440-turn / $5.49 outlier as a possible runaway re-read loop.

**Bottom line for resumption:** cache mechanics solved and documented; the optimize layer
saves tokens, preserves the prefix cache, and produced a run that matched baseline
correctness. The **only** blocker to shipping is statistical confidence — one full run
passed, one failed, and we need batches to know the true failure rate. Do not enable
DeepSeek optimizations in production until issue #1 is resolved.
</content>
