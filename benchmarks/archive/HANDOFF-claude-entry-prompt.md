# Claude/Bedrock benchmark — entry prompt

> **✅ COMPLETED / ARCHIVED.** The entry prompt used to kick off the Claude/Bedrock run.
> Findings are consolidated in [`../REPORT-optimize-layer.md`](../REPORT-optimize-layer.md).
> Kept for provenance.

Paste the block below to the Claude Code agent on the Bedrock machine. It assumes the shell
already has `AWS_PROFILE=claude` and Bedrock access.

---

Read `docs/optimize-cross-provider-eval.md` — it's your full task brief. Run a 3-way
optimize-layer benchmark with Claude Code on the `iterative-fix-plus` fixture, then write
`benchmarks/REPORT-iterative-fix-plus-bedrock.md` and push it to `feat/ollama-native-capture`.

## The three runs

1. **baseline** — no optimize
2. **optimize** — full optimize layer
3. **optimize-nps** — optimize with `prune_stale` OFF (the required control)

The point: on DeepSeek, enabling `prune_stale` on OpenAI-format traffic caused a **+491%**
cost regression and an agent loop; disabling only `prune_stale` restored a **−7%** win. Your
job is to determine whether `prune_stale` is harmful, harmless, or helpful on
Anthropic/Bedrock. The DeepSeek report (`benchmarks/REPORT-iterative-fix-plus-deepseek.md`)
is your reference for structure and expected shape.

## Setup (fresh machine — no `~/.aap`, no `config.toml` on the branch)

1. `git pull`, then **build + link so `aap` is on PATH** (the scripts call bare `aap`, which
   resolves to `dist/cli/aap.js`; running from source via `npm run dev` won't put it on PATH):
   ```
   npm install && npm run build && npm link
   aap help | grep "aap tag"        # sanity check it's the current build
   ```
2. Create a config. Easiest: put it at the repo root — `run.sh` auto-uses `./config.toml`
   when neither `AAP_CONFIG` nor `~/.aap/config.toml` exists:
   ```
   cp config.example.toml ./config.toml
   mkdir -p ~/.aap/data
   ```
   Edit `./config.toml`:
   - `[storage] dir` → an absolute path (e.g. `/Users/<you>/.aap/data`),
   - `[providers.bedrock].upstream` → your region's bedrock-runtime endpoint,
   - add a `[pricing."<model>"]` block keyed on the **exact** Bedrock model id (see the
     "Bedrock note" template in `config.example.toml`). Cost is computed locally from these
     rates — Bedrock responses carry no dollar amount — so no matching entry = null cost
     columns. Get the id from one warm-up call, then `aap export <session>` to read the model
     string. Include `cacheInputPerMTok`.
   - leave `[optimize]` at defaults.

## Runs 1 + 2 — baseline and optimize (one command)

```
./benchmarks/iterative-fix-ab.sh claude --fixture iterative-fix-plus
```

Starts its own isolated `aap serve` on port 8199 and runs the task twice: `--no-optimize`
(tag `baseline`) then `--optimize` (tag `optimize`). No manual serve needed. It costs real
Bedrock money and may take a while; the optimize phase may loop — let it finish.

## Run 3 — optimize-nps control (`prune_stale` OFF)

`ab.sh` can only toggle optimize on/off, not a single strategy, so run this one manually.
Port is controlled by the **`AAP_PORT` env var** (there is no `--port` flag on `aap serve`):

```
cp ./config.toml /tmp/aap-nps.toml
# edit /tmp/aap-nps.toml: under [optimize] set  pruneStale = false   (keep the same storage dir)

AAP_CONFIG=/tmp/aap-nps.toml AAP_PORT=8299 aap serve --optimize &
#   confirm the startup log line:  optimize: ON (...)  does NOT list prune_stale

AAP_CONFIG=/tmp/aap-nps.toml AAP_PORT=8299 \
  ./benchmarks/run.sh claude --fixture iterative-fix-plus --tag optimize-nps

kill %1   # stop that serve when done
```

## Report + push

```
aap compare --run baseline --run optimize --run optimize-nps
```

Write `benchmarks/REPORT-iterative-fix-plus-bedrock.md` mirroring the DeepSeek report:
Headline · Results (3-run compare table) · Per-bucket token breakdown · Key findings · A/B
control (`prune_stale` OFF) · Analysis (does turning off `prune_stale` change the Bedrock
result the way it did on DeepSeek?) · Config used (your Bedrock pricing + region) · Session
IDs (all three) · Conclusion. Then:

```
git add benchmarks/REPORT-iterative-fix-plus-bedrock.md
git commit -m "docs(bench): Claude/Bedrock optimize A/B on iterative-fix-plus"
git push origin feat/ollama-native-capture
```

Do **not** modify `compare.ts`, `run.sh`, or `layer.ts` — those are already fixed / under
test. If you hit a tooling bug, document it in the report instead of silently patching. Do
**not** commit `./config.toml` or `/tmp/aap-nps.toml`.

Start by reading the brief and giving me your plan (and any config gaps you spot) before
making paid Bedrock calls.
