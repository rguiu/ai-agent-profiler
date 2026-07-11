# DeepSeek Benchmark: baseline vs optimized

Single-run A/B on the **iterative-fix-plus** fixture, opencode → deepseek-v4-pro,
both scored with the fixed verify harness (Node ≥22, bounded tests). Reproduce with:

```
./benchmarks/iterative-fix-ab.sh          # runs baseline (--no-optimize) + optimize (--optimize)
```

Raw run data (gitignored, local only): `benchmarks/runs/baseline/`, `benchmarks/runs/optimize/`.

## Results

| Metric | baseline (no-opt) | optimize (cache-safe) |
|---|---|---|
| **Fixture tests** | **54 / 54 ✅** | **54 / 54 ✅** |
| **Edge tests** | 54 / 57 | 54 / 57 |
| Requests | 41 | 23 |
| Input tokens | 985,422 | 769,950 |
| Cached input | 984,192 | 731,648 |
| Cache hit rate | 100% | 96% |
| Output tokens | 7,081 | 19,492 |
| Cost | $0.0102 | $0.0363 |
| Wall time | 341.7s | 266.2s |

Optimizations that fired (optimize run):

| Strategy | Count | Tokens saved |
|---|---:|---:|
| frozen_compact | 1 | ~48,809 |
| stable_truncate | 10 | ~17,167 |
| shape_test_output | 13 | ~3,155 |
| prefix_break (diagnostic) | 2 | ~0 |
| **Total** | | **~69,131** |

> Note: "tokens saved" counts tokens the optimizer *removed from the prompt it sent*.
> It is **not** a cost saving — most removed tokens were cheap cached input ($0.0036/M),
> and (see below) the transformed prompt actually incurred *more* expensive uncached
> input this run. Treat this figure as "prompt shrinkage", not "money saved".

## Cost breakdown (why optimize cost more here)

Prices (deepseek-v4-pro): cached input $0.0036/M, uncached input $0.435/M, output $0.87/M.

| Component | baseline | optimize |
|---|---|---|
| cached input | 984,192 tok → $0.00354 | 731,648 tok → $0.00263 |
| uncached input | 1,230 tok → $0.00054 | 38,302 tok → $0.01666 |
| output | 7,081 tok → $0.00616 | 19,492 tok → $0.01696 |
| **total** | **$0.01024** | **$0.03625** |

The optimize run cost ~3.5× more. The gap is **not** from a cache reset caused by the
optimizer — per-request analysis (miss tokens minus new-content growth) shows **no reset
on any turn in either run** (baseline max excess-miss −99, optimize max +72; a reset would
be several thousand). Both ran healthy caches (100% / 96% hit). The gap comes from two
confounds:

1. **Output tripled (7,081 → 19,492 tok, +$0.011).** The agent generated far more this
   run. This is opencode path non-determinism, unrelated to the optimizer.
2. **Uncached input jumped (1,230 → 38,302 tok, +$0.016), but as legitimate first-sight
   misses, not resets.** The most likely cause is **cross-run cache warming**: the baseline
   re-sends verbatim fixture bytes that were already warm in DeepSeek's disk cache from
   earlier baseline runs, so almost nothing missed. The optimize run sends *transformed*
   bytes (truncated / shaped / compacted) that are novel to DeepSeek's cache → they cold-miss
   on first sight. This favors the verbatim baseline in a one-shot A/B and would shrink if
   the optimize arm were itself repeated (its own outputs would then be warm).

## Reading

- **Correctness is identical:** both solved 54/54 fixture and 54/57 edge. The optimizations
  did **not** degrade task success in this run.
- **The optimizer's own cache behavior is healthy** — no per-turn resets; 96% hit rate.
- **This single A/B cannot show a cost win or loss.** Output path-noise and cross-run cache
  warming both dominate the raw $ delta. Per-run cost is not a reliable optimizer signal
  here; pass/fail, per-turn cache health, and token composition are.

## Caveat (important)

This is **one run per arm**, and confounded (above). A separate heavy-optimization run
failed 45/54 — within opencode's run-to-run noise. With N=2 the failure rate is unknown,
and the cost comparison is not apples-to-apples. **Batch validation (N≥5 per arm, and
warm the cache for both arms equally before measuring) is required before any
cost/correctness claim** — see `docs/DEEPSEEK-FINDINGS.md` §9.

## Canonical artifacts

- **This file** — the comparison.
- `docs/DEEPSEEK-FINDINGS.md` — full investigation, mechanics, caveats, open issues.
- `docs/DEEPSEEK-CACHING.md` — the cache mechanism + measured evidence.
</content>
