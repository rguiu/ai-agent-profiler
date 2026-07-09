# HANDOFF — AI Agent Profiler

_For whoever continues this tomorrow. Written 2026-07-06._

## TL;DR

The **capture core + first analysis layer are shipped and green**. The most recent
work built an **evidence pipeline**: a benchmark runner that verifies task success and
tags sessions `verify=pass|fail`, plus a collector that rolls the numbers into
`benchmarks/BASELINES.md`. The project's whole point (`VISION.md`) is to turn the
`Baseline: TBD` slots in `docs/aish-requirements.md` into measured evidence — that's the
main thread to keep pulling.

- Repo: `git@github.com:rguiu/ai-agent-profiler.git`, branch `main`, clean & pushed.
- HEAD: `9cd7388` (feat(bench): baseline collector).
- Gates (all pass): `npm run typecheck && npm run lint && npm test && npm run format:check`
  — 110 tests.

## Read these first

- `VISION.md` — why this exists. **Profiler = evidence, AISH = optimisation.** The proxy is
  **transparent / read-only** ("never changes requests"). Behaviour-changing features are
  out of scope unless an explicit, off-by-default, measured `--optimize` mode.
- `ARCHITECTURE.md` — how it's built (up to date as of `c7f42d2`).
- `ROADMAP.md` — what's done / next (up to date).
- `docs/aish-requirements.md` — the 10 AISH capabilities, each with a `Baseline: TBD`
  slot. **This is the backlog that matters.**
- `AGENTS.md` / `CLAUDE.md` conventions: surgical changes, **no comments unless asked**,
  run lint+typecheck+tests before declaring done, **never commit/push unless asked**.

## Environment gotchas (these bit us)

1. **Rebuild after code changes.** The installed `aap` (via fnm/npm-link) runs `dist/`.
   After editing `src/**`, run `npm run build` or the CLI is stale. This caused a benchmark
   run to silently miss `aap tag` + `AAP_SESSION_ID`. `benchmarks/run.sh` now has a
   preflight warning for it.
2. **Two stores.** `aap serve` resolves config `~/.config/aap/config.toml` →
   `storage.dir = ~/.local/share/aap`. The project's `./config.toml` (`dir=data`) is a
   different, empty store. The live data is in `~/.local/share/aap/aap.sqlite`.
3. **`aap serve` on :8080 is still the OLD build** (pre-rebuild). Restart it
   (`Ctrl-C`, `aap serve`) to get the background parse tick + new `/ui` panels
   (shell commands, message-stack, cache-hit rate) and endpoints (`/commands`,
   `/requests/:id/messages`).
4. **`aap parse` is manual** (or the serve background tick). Raw traces → metrics/tool_calls
   only after parsing.
5. **DeepSeek pricing is unset** → cost shows `$0`. Add `[pricing."deepseek-v4-pro"]` to the
   global config if cost baselines matter.

## Where the data model lives

- Raw traces (source of truth): `~/.local/share/aap/traces/<session>/<request>.ndjson`.
- SQLite index: `~/.local/share/aap/aap.sqlite` (`sessions`, `requests`, `metrics`,
  `tool_calls`). Schema + rationale in `ARCHITECTURE.md` "Storage model".
- Rebuildable from traces; `ensureColumn` migrations upgrade in place.

## The main thread: generate AISH baselines

Pipeline is ready end-to-end. To collect evidence:

```
# terminal 1 (after: npm run build)
aap serve
# terminal 2, from the repo
./benchmarks/run.sh opencode --fixture csv-parser      # also: big-file, many-files, task-queue
aap parse
node benchmarks/baselines.mjs                          # -> benchmarks/BASELINES.md
```

- Run each fixture a few times (distributions, not single points).
- Add `claude` once its key is configured (the Claude Code path is built but **not yet
  validated end-to-end** — see ROADMAP / ARCHITECTURE "Open items").
- Then copy figures from `benchmarks/BASELINES.md` into the `Baseline:` slots of
  `docs/aish-requirements.md`. Metric→capability hints are in `benchmarks/baselines.mjs`.

Current `BASELINES.md` has only 1 opencode run per task (both `fix-bug`/`add-feature`
`verify=pass`). It needs more runs + more fixtures + a second agent to be meaningful.

## Good next tasks (pick by value)

1. **Grow baselines** (highest value, low code) — the runs above, then fill
   `docs/aish-requirements.md`. This is the reason the project exists.
2. **Validate the Claude Code path** end-to-end (base-URL routing, capture, parse). ROADMAP
   flags it as built-but-unconfirmed.
3. **Ordered `search → read(same file)` detection** — the `inefficient_search` rec is
   currently aggregate co-occurrence; ROADMAP has this as a `[ ]` follow-up. Needs an
   ordered per-session tool-call stream (requests ordered by time × tool_calls.ordinal).
4. **UI polish** — latency/cost-over-time charts, live auto-refresh, a search bar
   (ROADMAP "Later: Analysis & Presentation").
5. Small niceties offered but not done: `npm run baselines` script alias; DeepSeek pricing.

## Recent commits (context)

```
9cd7388 feat(bench): baseline collector (benchmarks/baselines.mjs -> BASELINES.md)
8e11caf fix(bench): accurate tag-failure message + preflight for stale aap build
c7f42d2 docs(architecture): reconcile with shipped analysis layer
4cd44d9 feat(bench): verify-and-score task runner + aap tag session metadata
6391133 docs: reconcile README/ROADMAP/aish; feat(ui): prompt-cache hit rate
```

## Layout quick map

- `src/proxy` transparent proxy + `/health`, `/_control/sessions`.
- `src/capture` async NDJSON tee + redaction. `src/store` SQLite (all queries/migrations).
- `src/parse` metrics + `summarizeMessages` (message stack). `src/analyze` shell-command
  classifier/categories. `src/recommend` per-session findings.
- `src/api` read endpoints. `src/ui` serves `web/` (plain HTML/CSS/JS, no framework).
- `src/cli` verbs: serve, run, parse, sessions, commands, tag, export, compare, mcp, config.
- `benchmarks/` fixtures + `run.sh` (verify+tag) + `baselines.mjs`.

Don't commit/push unless the user asks. Leave `~/.local/share/aap` alone unless intending
to mutate real captured data.
