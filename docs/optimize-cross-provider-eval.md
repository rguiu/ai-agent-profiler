# Cross-Provider Optimize-Layer Evaluation — Claude/Bedrock

**You are the Claude Code agent running on a machine with AWS Bedrock access.** This is your
task brief. Read it fully, run the A/B benchmark, write a report, and push it to this branch.
Do not merge; the human will review.

## Why you're doing this

We ran the optimize layer A/B on **DeepSeek (opencode)** and got a **bad** result:
optimize cost **+491%**, used **+217% tokens**, looped (**117 vs 49 requests**), and scored
**worse** on hidden tests. Full writeup:
[`benchmarks/REPORT-iterative-fix-plus-deepseek.md`](../benchmarks/REPORT-iterative-fix-plus-deepseek.md).

We traced the root cause and **confirmed it with a control run**: an uncommitted edit to
`src/optimize/layer.ts` made the `prune_stale` strategy fire on **OpenAI-format** traffic
(opencode→DeepSeek) for the first time. Previously `prune_stale` was a silent no-op on that
format (it only matched Anthropic's array-shaped tool results), so the earlier DeepSeek "win"
(−78%, `REPORT-iterative-fix-opencode.md`) actually came from `pruneUnusedTools` +
`stablePrefix`, which are cache-safe.

The DeepSeek control was decisive — disabling **only** `prune_stale` flipped the result:

| Run (DeepSeek)                 | Cost vs baseline | Requests    | Uncached tok | Cache hit |
| ------------------------------ | ---------------- | ----------- | ------------ | --------- |
| optimize (prune_stale ON)      | **+491%**        | 117 (+139%) | +1016%       | 94%       |
| optimize-nps (prune_stale OFF) | **−7%**          | 22 (−55%)   | +9%          | 96%       |

So on DeepSeek, `prune_stale` is the whole regression, and the other strategies are a net
win. **Your job is to determine whether the same is true on Anthropic/Bedrock.**

**Where you come in — Claude/Bedrock is the missing quadrant.** Claude Code sends
**Anthropic array-format** tool results, so `prune_stale` has _always_ been active for it —
and on Claude an earlier run _helped_ (the v2 report,
[`benchmarks/REPORT-iterative-fix-v2.md`](../benchmarks/REPORT-iterative-fix-v2.md), showed
−77% cost + reliability gains). But that run used a **different, smaller fixture** and
**pre-fix token accounting**. The open questions your runs answer:

> 1. On Bedrock, does the full optimize layer still win on the **harder** `iterative-fix-plus`
>    fixture, with corrected token accounting?
> 2. Is `prune_stale` **load-bearing or harmful** on Anthropic/Bedrock? I.e. does turning it
>    off (optimize-nps) change the result the way it did on DeepSeek, or not?

We need Claude/Bedrock runs on the **same fixture** (`iterative-fix-plus`) the DeepSeek runs
used, so the only variables vs DeepSeek are **agent (opencode → claude)** and **provider
(DeepSeek → Bedrock)**.

## What "done" looks like

A new file `benchmarks/REPORT-iterative-fix-plus-bedrock.md`, committed and pushed to branch
`feat/ollama-native-capture`, containing results for **three runs** on the same fixture:

- **baseline** (no optimize)
- **optimize** (full optimize layer, `prune_stale` ON)
- **optimize-nps** (optimize layer with `prune_stale` OFF — the control)

The report must include:

1. The corrected `aap compare --run baseline --run optimize --run optimize-nps` table.
2. The per-bucket token/cost breakdown (cached vs uncached vs output) for each run — see the
   DeepSeek report's tables for the exact shape to reproduce.
3. Whether optimize helped or hurt on Bedrock, and by how much, for both the full layer and
   the prune_stale-OFF control.
4. **The key comparison:** does turning off `prune_stale` change the Bedrock result the way it
   did on DeepSeek (+491% → −7%)? Or is `prune_stale` harmless / helpful on Anthropic format?
5. Fixture vs edge (hidden) test scores for all three runs (task success matters, not just
   tokens).
6. Your analysis addressing the hypotheses below.

> **Why three runs, not two:** the two-run A/B only tells us if the _whole_ layer wins on
> Bedrock. The `optimize-nps` control is what actually answers the science question — is
> `prune_stale` the difference-maker on Anthropic format, or not. This is the single most
> important data point; do not skip it.

## Prerequisites (verify before running)

1. **Build + link the CLI** (the benchmark runs `dist/`, not `src/`):
   ```
   npm install && npm run build && npm link
   aap help | grep -E "serve|compare|tag"    # sanity check
   ```
2. **Bedrock creds available to `aap serve`.** The proxy SigV4-re-signs Bedrock traffic, so
   AWS credentials must be in the environment (e.g. `AWS_PROFILE=claude`). Confirm with
   `aws sts get-caller-identity`.
3. **Claude Code installed and pointed at Bedrock:** `CLAUDE_CODE_USE_BEDROCK=1`. `aap run
claude` overrides `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` to route through the proxy.
4. **Config.** `aap` resolves `$AAP_CONFIG` → `~/.aap/config.toml` → `./config.toml`.
   - Set `[providers.bedrock].upstream` to your region's endpoint (default in
     `config.example.toml` is `eu-west-1`).
   - **Add a pricing entry for the exact model Bedrock reports.** Cost is **always computed
     locally** from these rates — Bedrock responses report token usage, never a dollar amount,
     and the proxy is read-only. Without a matching `[pricing."<model>"]` block, cost is
     `null` (never faked), and the cost comparison — the whole point — is empty. The model
     **key must match the id Bedrock reports** (the full path string, e.g.
     `eu.anthropic.claude-sonnet-4-...-v1:0`), _not_ the short name. Do one warm-up call, then
     `aap sessions`/`aap export` to read the exact model string, and key on it. A
     copy-paste template (with the region-prefixed key shape) is in `config.example.toml`
     under "Bedrock note". Include `cacheInputPerMTok` — the whole DeepSeek finding hinges on
     the cached-vs-uncached spread, so Bedrock's cache-read price must be set for a fair
     comparison.
5. **`config.toml` `[optimize].enabled`** — the A/B script forces both states explicitly
   (`--no-optimize` then `--optimize`), so it works regardless, but note the current default.

## Run it

### Step 1 — baseline + optimize (the two-run A/B)

The one-shot A/B runner starts its own isolated `aap serve` on port 8199, runs the task
twice (baseline `--no-optimize`, then `--optimize`), parses, and prints the comparison:

```
AWS_PROFILE=claude ./benchmarks/iterative-fix-ab.sh claude --fixture iterative-fix-plus
```

- If port 8199 is busy, add `--port <N>`.
- The task is a single long fix-bugs-then-implement-methods session (~50+ requests each
  phase). Expect it to take a while and to make real Bedrock calls (it costs money).

### Step 2 — optimize-nps control (`prune_stale` OFF) — REQUIRED

This is the decisive run. There is no per-strategy CLI flag, so use a temp config copy with
`pruneStale = false` pointing at the **same storage dir** (so it lands next to your baseline
for comparison). This mirrors exactly how the DeepSeek control was produced:

```sh
# 1. Copy your active config and disable ONLY prune_stale.
#    (Adjust the source path if your config lives elsewhere; see resolution order below.)
cp ~/.aap/config.toml /tmp/aap-nps-config.toml
#    Edit /tmp/aap-nps-config.toml: set the line under [optimize] to
#      pruneStale = false
#    Leave every other strategy and the [storage] dir unchanged.

# 2. Start an isolated optimize serve on 8199 using that config, and confirm
#    prune_stale is NOT in the active strategy list it prints on startup.
AWS_PROFILE=claude AAP_CONFIG=/tmp/aap-nps-config.toml AAP_PORT=8199 aap serve --optimize &
#    -> log should read: optimize: ON (dedup, truncate, stablePrefix, suppressReread,
#       collapseSystem, pruneUnusedTools)   [NO prune_stale]

# 3. Run the SAME task through it, tagged optimize-nps.
AWS_PROFILE=claude AAP_CONFIG=/tmp/aap-nps-config.toml AAP_PORT=8199 \
  ./benchmarks/run.sh claude --fixture iterative-fix-plus --tag optimize-nps

# 4. Stop the isolated serve when done (kill the backgrounded aap serve).
```

Verify on startup that the printed `optimize: ON (...)` list **omits `prune_stale`** — that is
your proof the control is configured correctly.

### Manual A/B alternative

If you must run baseline/optimize phases manually (e.g. to attach AWS creds differently), see
the "Manual" section of [`benchmarks/README.md`](../benchmarks/README.md#manual) — the key is
tagging (`--tag baseline` / `--tag optimize`) and starting `aap serve` with `--no-optimize`
vs `--optimize`. Keep all three runs in the **same storage dir** so `aap compare` sees them.

## Gather the data for the report

After all three runs:

```
aap compare --run baseline --run optimize --run optimize-nps    # corrected table (copy verbatim)
```

Per-bucket breakdown — run for each of the three session IDs (`aap sessions` shows them by
`run=` tag). Substitute your Bedrock cache/input/output rates:

```
aap export --json <session-id> | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const d=JSON.parse(s), rq=d.requests||[];
  let inTot=0,cached=0,out=0,cost=0;
  for(const r of rq){inTot+=r.input_tokens||0;cached+=r.cached_input_tokens||0;out+=r.output_tokens||0;cost+=r.cost||0;}
  console.log("reqs",rq.length,"prompt",inTot,"cached",cached,"uncached",inTot-cached,"out",out,"cost $"+cost.toFixed(4));
  const m=d.session&&d.session.meta; console.log("verify",m&&m.verify,"fixture",m&&m.fixture,"edge",m&&m.edge);
});'
```

**IMPORTANT — token accounting differs by provider.** For **Bedrock/Anthropic**,
`input_tokens` is the **uncached remainder** and cache reads are counted separately (so
`total = input + cached`). For **OpenAI/DeepSeek**, `input_tokens` **already includes**
cached (so `uncached = input − cached`). The `compare.ts` table now handles this
automatically (format-aware), but if you compute anything by hand, use the Anthropic
convention for Bedrock. See `summarize()` in `src/cli/compare.ts` and `cachedIsInInput()`.

## Hypotheses to test (address each in your report)

1. **`prune_stale` on Anthropic/Bedrock cache — the headline test.** On DeepSeek, enabling
   `prune_stale` dropped cache hit 98%→94%, raised uncached tokens +1016%, and cost +491%;
   disabling it (optimize-nps) restored −7% cost / −55% requests. Does Bedrock behave the same
   way, or does Anthropic prompt caching tolerate mid-prefix mutation? **Compare your three
   runs directly:** if optimize and optimize-nps are close on Bedrock, `prune_stale` is safe
   there; if optimize-nps is much better (like DeepSeek), `prune_stale` is harmful on Bedrock
   too. Report cache-hit rates and `prune_stale` action counts (`aap export <optimize-id>` →
   "Optimizations applied").
2. **Reliability under pruning.** DeepSeek looped (2.4× requests) and scored worse on hidden
   tests with `prune_stale` on. Does Claude loop or degrade? Compare request counts and
   fixture/edge scores across all three runs. Note: on DeepSeek, the edge-test dip (17→14/18)
   appeared in **both** optimized runs, so it was **not** attributable to `prune_stale` — watch
   for the same ambiguity and call it out rather than over-attributing.
3. **Does the full layer still win on the harder fixture?** The −77% Claude win was on the
   older, smaller `iterative-fix` fixture with pre-fix accounting. Confirm or refute it on
   `iterative-fix-plus` with the corrected `compare.ts`.

## Report skeleton

Mirror [`benchmarks/REPORT-iterative-fix-plus-deepseek.md`](../benchmarks/REPORT-iterative-fix-plus-deepseek.md)
so the two are directly comparable. Sections: Headline · Results (3-run compare table) ·
Per-bucket breakdown · Key findings table · **A/B control (`prune_stale` OFF)** — the
DeepSeek report has this exact section, replicate it · Analysis (the 3 hypotheses +
cross-provider contrast with the DeepSeek numbers) · Config used (your Bedrock pricing block +
region) · Session IDs (all three) · Conclusion.

## Report skeleton

Mirror [`benchmarks/REPORT-iterative-fix-plus-deepseek.md`](../benchmarks/REPORT-iterative-fix-plus-deepseek.md)
so the two are directly comparable. Sections: Headline · Results (compare table) · Key
findings table · Analysis (the 3 hypotheses + cross-provider contrast) · Config used
(including your Bedrock pricing block and region) · Session IDs · Conclusion.

## Commit & push

```
git checkout feat/ollama-native-capture       # you should already be here
git add benchmarks/REPORT-iterative-fix-plus-bedrock.md
git commit -m "docs(bench): Claude/Bedrock optimize A/B on iterative-fix-plus"
git push origin feat/ollama-native-capture
```

Do **not** modify source, config committed to the repo, or the DeepSeek report. The one
exception is your temp `pruneStale = false` config — keep that in `/tmp`, never commit it. If
you hit a tooling bug (like the token double-count or the `0/0` test-scoring bug we already
fixed here), **document it in your report** rather than silently patching — the human wants to
see it.

> **Note on the branch you're pulling:** it already contains the fixes made during the
> DeepSeek investigation — the format-aware `compare.ts` (correct cached-vs-uncached
> accounting), the `run.sh` TAP-footer test scoring, and the two reports. You should **not**
> re-fix those. It also still contains the uncommitted-then-committed `prune_stale` change to
> `src/optimize/layer.ts` (the OpenAI-format branch) — that is intentional; it's the behaviour
> under test. Do a clean `npm install && npm run build && npm link` after checkout so `dist/`
> matches.

## Gotchas (learned the hard way)

- **Rebuild after any code change** — the installed `aap` runs `dist/`, so stale builds
  silently drop `aap tag`/`AAP_SESSION_ID` behavior.
- **Bedrock routing is host-based, not per-session** — don't run other Bedrock traffic
  through the same proxy during the benchmark, or sessions mis-attribute.
- **Cost shows `$0`/`null`?** Your `[pricing."<model>"]` key doesn't match the model string
  Bedrock reports. Fix the key, re-run `aap parse`.
- **The optimize run may be long and may loop** (it did on DeepSeek — 117 requests, 30 min).
  If it runs away past ~2× the baseline request count, let it finish anyway — that _is_ a
  result worth reporting.
- **Keep all three runs in one storage dir.** baseline/optimize (from the A/B script) and
  optimize-nps (from the manual control) must share the same `[storage] dir` or `aap compare`
  won't see them together. The temp config only changes `pruneStale`, not `dir`.
- **`iterative-fix-ab.sh` refuses to start if `benchmarks/runs/<tag>` already exists.** If you
  re-run, prune first: `./benchmarks/run.sh claude --prune --tag <tag>` (removes the run dir
  and its sessions), or pick a fresh tag.
