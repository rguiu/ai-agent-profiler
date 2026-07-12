# Recomputing old runs after the cache-write cost fix

**Why:** before the cache-write accounting fix (PR #9), `computeCost` ignored
Anthropic/Bedrock **cache-creation (cache WRITE) tokens** and mis-handled
fresh-input semantics, so Claude/Bedrock costs were **undercounted** — which
likely **inflated** the measured optimize savings. This note is how to recompute
the old runs with the corrected code and see how far off the numbers were.

The fix is **cost-neutral for OpenAI/DeepSeek** (no cache writes), so this only
moves the needle on **Anthropic/Bedrock (Claude)** runs — which live on the work
machine, not the laptop used to develop the tool.

## Prerequisites (on the machine that has the Claude traces)

1. Get the fixed code and build it:
   ```sh
   git pull                     # main, once PR #9 is merged (or check out the branch)
   npm install && npm run build
   ```
2. Make sure the **trace files still exist** for the old sessions
   (`~/.aap/data/traces/<session-id>/…`). Recompute re-parses those raw traces;
   if they were deleted, only a fresh re-run can recover the numbers.
3. Set **current Opus pricing incl. the write rate** in `~/.aap/config.toml`.
   The model key must match what Bedrock reports in the request path
   (e.g. `eu.anthropic.claude-opus-4-8`). Verify rates at anthropic.com/pricing:
   ```toml
   [pricing."eu.anthropic.claude-opus-4-8"]
   inputPerMTok      = 5.0
   outputPerMTok     = 25.0
   cacheInputPerMTok = 0.50   # cache read  (0.1x input)
   cacheWritePerMTok = 6.25   # cache write (1.25x input)  ← the newly-priced bucket
   ```
   (Repeat for every Opus model id your runs used.)

## Step 1 — read-only diff (do this first, non-destructive)

```sh
node benchmarks/recompute.mjs
```

This re-parses every captured request with the fixed parser/cost model and diffs
against the cost stored at capture time. Read the output like this:

- **`cacheWrite` column > 0** on your Claude configs → those cache-write tokens
  were unpriced before. This is the bug's fingerprint and the real correction.
- **`Δ%`** = how the recomputed cost compares to the old stored cost, per config
  (`meta.run`). On Claude runs with cache writes, expect the corrected cost to be
  **higher** (Δ positive) than what was reported.
- If `cacheWrite` is 0 for a config, any Δ there is **pricing-config drift**
  (different rates in effect when it was first parsed), _not_ this fix — ignore it.

**The corrected savings** = compare the recomputed **new $** of your baseline
config vs your optimize config (not the old $). e.g. if baseline new-$ = X and
optimize new-$ = Y, the true saving is `(X − Y) / X`. That replaces the old 77%.

## Step 2 — persist the corrected costs + get confidence intervals (optional)

To bake the corrected costs into the store and then run the statistical check:

```sh
aap parse --all                       # re-derives metrics/cost from traces (rewrites the DB)
node benchmarks/validate.mjs --agent claude \
     --baseline <baseline-run-label> --optimized <optimize-run-label>
```

Notes:

- `aap parse --all` **modifies** the store (recomputes every session's cost).
  That's the intended correction, but back up `~/.aap/data/aap.sqlite` first if
  you want to keep the old numbers for comparison.
- After re-parsing, `input_tokens` means **fresh** (non-cached) tokens, so
  `validate.mjs`'s `cacheHit` column can read oddly (fresh is small) — trust the
  **cost** columns, not the cache-hit display, for this exercise.

## What to do with the result

1. Record the corrected baseline→optimize saving (with CIs from Step 2).
2. Update the headline number wherever the old 77% appears:
   `docs/OPTIMIZATION-STRATEGIES-REPORT.md` and the article draft.
3. If the corrected saving is materially different, say so plainly — a public
   correction ("re-measured with cache-write costs included; the real figure is
   N%") is the credibility-building move, same as the earlier DeepSeek fix.

## Isolating the fix from pricing drift (if you want a clean before/after)

The cleanest apples-to-apples is to recompute **both** the old and new code paths
with the **same** pricing. Practically: run Step 1 (new code, current pricing) and
compare configs to each other (baseline vs optimize) rather than to the old stored
cost. The baseline-vs-optimize ratio is unaffected by pricing drift, so it's the
number to trust.
