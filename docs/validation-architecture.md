# Validation & Benchmark Architecture

How ai-agent-profiler validates, benchmarks, and regression-tests AI coding agents.

## Overview

The validation system shifts from superficial "pass/fail" metrics to a deep,
statistically sound engineering framework. It decouples the hot path (agent
execution via the proxy) from the cold path (analysis, statistical testing,
reporting) so benchmark runs are reproducible and analysis never interferes with
the agent being measured.

```
 ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
 │  Agent CLI   │────▶│  aap proxy   │────▶│  LLM API(s)  │
 │  (opencode,  │     │  (hot path,  │     │  (Anthropic, │
 │   claude, …)  │     │   tees to    │     │   OpenAI,    │
 └─────────────┘     │   capture)    │     │   DeepSeek)  │
                     └──────┬───────┘     └──────────────┘
                            │ NDJSON traces
                     ┌──────▼───────┐
                     │  Parse /     │
                     │  Store       │  ← off-hot: idempotent, replayable
                     │  (SQLite)    │
                     └──────┬───────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Analyze /   │   │  Recommend   │   │  Search      │
│  Classify    │   │  (anomalies, │   │  (FTS5)      │
│  (commands,  │   │   patterns)  │   │              │
│   cache, …)  │   │              │   │              │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Statistical │   │  Regression  │   │  Baseline    │
│  Validation  │   │  Guards      │   │  Collection  │
│  (bootstrap, │   │  (TOML cfg,  │   │  (per-agent  │
│   CI, d, BH) │   │   CI gate)   │   │   means)     │
└──────────────┘   └──────────────┘   └──────────────┘
```

**Design principles:**

- **Record first, analyze later.** The proxy is byte-faithful with sub-millisecond
  overhead. All metrics are derived off the hot path from raw NDJSON traces.
- **Raw traces are authoritative.** The SQLite index can always be rebuilt via
  `aap parse --all`.
- **Provider-agnostic.** Adding a provider is config-only. Pricing is never
  hardcoded.
- **Idempotent operations.** Parse, index, and baseline collection are all
  keyed by `request_id` or `session_id` — re-running them produces the same result.
- **Localhost only.** No telemetry, no cloud dependency.

## Fixture Model

Fixtures are small, self-contained mini-repos committed under
`benchmarks/fixtures/<name>/`. Each fixture is a reproducible, version-controlled
testing ground — not a clone of a random public repo.

### Fixture structure

```
benchmarks/fixtures/<name>/
├── package.json          # Minimal deps; prefer zero dependencies
├── src/                  # Source files with planted bugs (for fix tasks)
├── test/                 # Test suite that verifies correctness
├── TASKS                 # One task per line: id|prompt[|verify]
└── (optional README)
```

### TASKS file format

```
# Lines starting with # are comments
explain|Explain what this project does. Do not change any files.|
locate|Identify the main entry point. Do not change any files.|
fix-bug|The tests are failing. Find and fix the bug.|npm test
add-feature|Add X feature. Tests for X exist but are skipped.|npm test
```

Each line: `task-id|prompt|[verify-command]`

- **task-id**: unique ID for this task within the fixture
- **prompt**: exact prompt sent to the agent
- **verify-command**: shell command run after the agent finishes; exit 0 = pass,
  exit non-zero = fail. If omitted, the task is read-only (not scored).

### Reference files

Grading tests that must NOT leak into the agent's context are stored in
`benchmarks/reference/<fixture>/`. The verify command references them via
`$AAP_BENCH_REF`, e.g.:

```
cp "$AAP_BENCH_REF"/methods.test.js test/ && node --test test/*.test.js
```

### Bundled fixtures

| Fixture              | Shape                                  | Stresses                                     |
| -------------------- | -------------------------------------- | -------------------------------------------- |
| `csv-parser`         | Single module + tests, 1 planted bug   | Reading, fixing, small edit                  |
| `task-queue`         | Multi-file lib (queue/scheduler/store) | Cross-file reasoning, locate logic           |
| `iterative-fix-plus` | 7 modules, 9 bugs + 3 method stubs     | Deep read-fix-verify cycles, auto-compaction |
| `big-file`           | One ~220-line module                   | Read amplification, paging threshold         |
| `many-files`         | 40 tiny handler modules + registry     | Search/exploration cost                      |

### Per-task isolation

`benchmarks/run.sh` copies the fixture to a **fresh scratch directory** per task
(`/tmp/aap-bench/<task>`), drops `.git`/`TASKS`, then runs the agent there. This
prevents state bleeding between tasks and ensures each run starts from an
identical codebase.

## Agent Adapter Model

Agent configuration lives in `benchmarks/agents.toml` — a version-controlled
registry that replaces hardcoded invocations in shell scripts.

### Schema

```toml
[opencode]
binary = "opencode"
invoke = "run --auto"
env = {}

[claude]
binary = "claude"
invoke = "-p --dangerously-skip-permissions"
env = { CLAUDE_CODE_USE_BEDROCK = "1" }

[stackpilot]
binary = "stackpilot"
invoke = "--yolo -p"
env = {}
```

**Fields:**

| Field    | Description                                        |
| -------- | -------------------------------------------------- |
| `binary` | CLI executable name (must be on PATH)              |
| `invoke` | Arguments passed to the binary for headless mode   |
| `env`    | Environment variables set before launch (optional) |

### Adding a new agent

1. Add a `[section]` to `benchmarks/agents.toml`
2. Add the corresponding pricing entry to `config.toml` `[pricing]`
3. Run: `./benchmarks/run.sh <agent> --fixture <name>`

No code changes needed.

## Statistical Validation

`benchmarks/validate.mjs` provides the statistical analysis layer. It operates
on sessions tagged by the benchmark runner (`meta.run`, `meta.task`, `meta.agent`,
`meta.verify`).

### Metrics computed

| Metric         | Source                                      | Description                          |
| -------------- | ------------------------------------------- | ------------------------------------ |
| Cost           | `metrics.cost`                              | Total USD across all requests        |
| Success rate   | `meta.verify`                               | Proportion of `verify=pass`          |
| Fixture score  | `meta.fixture`                              | Proportion of fixture tests passed   |
| Edge score     | `meta.edge`                                 | Proportion of edge-case tests passed |
| Cache hit rate | `metrics.cached_input_tokens / total_input` | Prompt-cache efficiency              |
| Requests       | `COUNT(requests)`                           | Total API calls                      |
| Input tokens   | `SUM(input_tokens)`                         | Fresh (uncached) input               |
| Output tokens  | `SUM(output_tokens)`                        | Model response tokens                |

### Bootstrap non-inferiority test

For each metric, we compute:

1. **Observed difference:** `Δ = mean(opt) − mean(baseline)`
2. **Bootstrap distribution:** Resample both arms 5,000 times with replacement,
   compute `Δ` on each resample.
3. **95% confidence interval:** 2.5th and 97.5th percentiles of the bootstrap
   distribution.
4. **Non-inferiority verdict:**
   - For cost/requests: opt is non-inferior if the upper CI bound ≤ +margin × baseline
   - For success rate/scores: opt is non-inferior if the lower CI bound ≥ −margin
   - Default margin: 5 percentage points

### Effect size (Cohen's d)

Cohen's d measures the standardized difference between two groups, independent
of sample size:

```
d = (mean_opt − mean_baseline) / pooled_std
```

Interpretation:

- |d| < 0.2: negligible
- 0.2 ≤ |d| < 0.5: small
- 0.5 ≤ |d| < 0.8: medium
- |d| ≥ 0.8: large

Reported alongside the bootstrap CI to give a scale-free sense of practical
significance.

### Multiple-comparison correction (Benjamini-Hochberg)

When comparing multiple metrics simultaneously (e.g., cost, success rate, cache
hit rate across tasks), the false-discovery rate (FDR) increases. The
Benjamini-Hochberg procedure controls FDR:

1. Sort p-values across all comparisons: `p₁ ≤ p₂ ≤ … ≤ pₘ`
2. For each `pᵢ`, compute the BH critical value: `(i/m) × α` (α = 0.05)
3. Reject all hypotheses where `pᵢ ≤ (i/m) × α`

Output lists which comparisons survive BH correction and which are flagged as
potentially spurious.

## Regression Guards

Regression thresholds are stored in `benchmarks/regressions.toml` — a
version-controlled configuration that defines acceptable bounds for each metric.

### Schema

```toml
# Non-inferiority margin for quality metrics (decimal, not percent)
[metrics]
default_margin = 0.05

# Per-metric thresholds — violations cause CI to fail
[thresholds.cost]
max_increase_pct = 10.0

[thresholds.success_rate]
max_decrease_pp = 5.0

[thresholds.cache_hit_rate]
max_decrease_pp = 10.0

[thresholds.requests]
max_increase_pct = 20.0

# Per-task overrides (optional)
[thresholds."fix-bug"]
cost_max_increase_pct = 15.0
success_max_decrease_pp = 10.0
```

### Usage

```bash
# Compare current run against a baseline and check regression thresholds
aap check --baseline <run-tag> --current <run-tag>

# JSON output for CI consumption
aap check --baseline <run-tag> --current <run-tag> --json

# Specify a custom regressions file
AAP_REGRESSIONS=./my-regressions.toml aap check --baseline v1 --current v2
```

`aap check` exits:

- **0** — all metrics within thresholds (pass)
- **1** — one or more metrics exceed thresholds (fail)
- **2** — insufficient data to evaluate (e.g., no sessions for a run tag)

### CI integration

```yaml
# In .github/workflows/benchmark.yml (or ci.yml)
- name: Check regression thresholds
  run: aap check --baseline "$BASELINE_TAG" --current "$CURRENT_TAG"
  env:
    AAP_REGRESSIONS: benchmarks/regressions.toml
```

## Anomaly Tracing

The `src/recommend/` module and `src/analyze/` module detect execution patterns
that indicate inefficiency or bugs — surfaceable in `aap compare` and the
dashboard UI.

### Currently detected

| Anomaly             | Detector                 | Threshold                                           |
| ------------------- | ------------------------ | --------------------------------------------------- |
| Repeated file reads | `recommend.recommend()`  | ≥3 reads of same file with identical args           |
| Repeated tool calls | `recommend.recommend()`  | ≥3 calls with identical args                        |
| High amplification  | `recommend.recommend()`  | Tool results ≥3,000 tokens                          |
| Context duplication | `recommend.recommend()`  | Tool defs re-sent ≥2,000 tokens per request         |
| Context growth      | `recommend.recommend()`  | Last input ≥10k tokens and ≥3× first input          |
| Stalled streams     | `recommend.recommend()`  | Request latency ≥120s                               |
| Prefix cache reset  | `recommend.recommend()`  | Miss tokens exceed growth by ≥5k                    |
| Search→read chains  | `recommend.recommend()`  | Search commands followed by reads of searched files |
| Cache regeneration  | `analyze/cache-regen.ts` | Cache reads drop to zero mid-session then resume    |

### Tool-call loops

Detected by `analyze/loops.ts`: any tool called ≥4 times consecutively (without
interleaved calls to other tools) with the same name. Severity scales with
iteration count and whether the arguments change.

### Infinite reads

Detected when the same file is read ≥5 times within a session without any write
to that file. This indicates the agent is unable to locate the information it
needs and is re-reading the same content.

### Context bloat

Detected when a session's total input tokens exceed 200K without an intervening
compaction event (`cc_is_subagent` with `kind=summary` or similar). The agent
may be carrying too much stale context.

## Storage & Retention

Raw NDJSON traces and SQLite databases grow unbounded by default. The retention
system prevents storage bloat.

### Retention config

```toml
# In config.toml (optional section)
[retention]
max_trace_age_days = 30    # Delete traces older than N days (0 = keep forever)
max_runs = 50              # Keep at most N benchmark run directories
max_sessions = 1000        # Keep at most N sessions in SQLite
prune_on_startup = true    # Run prune on aap serve startup
```

### Prune CLI

```bash
# Prune sessions older than 30 days (traces + DB records + run dirs)
aap prune --older-than 30

# Dry run: print what would be removed
aap prune --older-than 30 --dry-run

# Keep at most 50 sessions
aap prune --keep-last 50

# Force-delete specific sessions
aap prune --session <id> --session <id>
```

### Prune behavior

1. Resolves sessions matching the criteria
2. Deletes trace files from `data/traces/<session-id>/`
3. Deletes associated rows from SQLite (CASCADE: requests → metrics → tool_calls)
4. Removes corresponding `benchmarks/runs/<run>/` directories
5. Removes search index entries (FTS5)

All operations run inside a transaction for the SQLite portion.

## Budget Caps

Prevents runaway agent loops from exhausting API credits during benchmark runs.

### Budget config

```toml
# In benchmarks/regressions.toml
[budget]
max_total_cost_usd = 20.00       # Hard cap per benchmark suite
max_per_task_cost_usd = 5.00     # Hard cap per individual task
```

### Runtime behavior

`benchmarks/run.sh` checks after each task:

1. Reads current total cost from the DB: `SUM(metrics.cost)` for sessions with
   `meta.run = <current-run>`
2. If `total_cost > max_total_cost_usd`: prints a warning, aborts remaining
   tasks, and tags the run as `budget_exceeded=true`
3. If `per_task_cost > max_per_task_cost_usd`: marks that task as over budget,
   continues to next task

### Budget estimation

```bash
# Estimate cost for an in-progress session
aap budget --estimate <session-id>

# Project final cost based on rate of spending
aap budget --project <session-id>
```

Uses linear extrapolation: `(current_cost / elapsed_ms) × (expected_duration_ms)`.

## Human-in-the-Loop (HITL) Quality Metrics

**Status: planned, not yet implemented.**

Many tasks (code review, documentation, refactoring) are difficult to judge via
automated `verify=pass|fail` alone. The HITL layer adds qualitative scoring.

### Multi-dimensional scoring

```bash
# Tag a session with rubric scores
aap tag <session-id> rubric.readability=4 rubric.correctness=5 rubric.architecture=3
```

### LLM-as-a-judge

```bash
# Score an agent's output using a rubric and a cheap model
aap judge <session-id> --rubric benchmarks/rubrics/iterative-fix-plus.toml
```

The judge:

1. Exports the session's agent-produced code (from saved artifacts)
2. Sends the code + rubric to a cheap model (e.g., Haiku) via the proxy
3. Records scores as session metadata
4. Reports scores with model-provided justifications

### Rubric format

```toml
# benchmarks/rubrics/iterative-fix-plus.toml
[correctness]
weight = 0.5
description = "Does the fix make all tests pass without breaking anything?"
scale = { min = 1, max = 5 }

[readability]
weight = 0.2
description = "Is the code idiomatic, well-structured, and easy to follow?"
scale = { min = 1, max = 5 }

[architecture]
weight = 0.3
description = "Does the solution respect existing patterns and design?"
scale = { min = 1, max = 5 }
```

## Model Drift Tracking

Anthropic and other providers may update model weights without changing the
model ID. The proxy captures response headers that can help detect drift.

### Captured headers

When available from the provider response:

- `x-request-id`: request identifier for provider-side debugging
- `anthropic-ratelimit-*`: rate-limit headers (inputs/outputs/requests remaining)
- Model version/snapshot identifier (if present in response body)

### Drift detection

```bash
# Compare model versions between two runs
aap check --model-drift --baseline <tag> --current <tag>
```

Warns if the model reported a different version or response characteristics
(rate limits, latency distribution) diverged significantly between runs.

## Commands Cheat Sheet

### Running benchmarks

```bash
aap serve                                          # Start the proxy
./benchmarks/run.sh <agent> --fixture <name> --tag <tag>  # Run benchmark
```

### Comparing results

```bash
aap compare --run <tag1> --run <tag2>              # Side-by-side per task
aap compare --task <task>                          # All sessions for a task
node benchmarks/baselines.mjs                      # Generate per-agent means
```

### Statistical validation

```bash
node benchmarks/validate.mjs --baseline <tag> --optimized <tag>
```

### Regression checks

```bash
aap check --baseline <tag> --current <tag>         # Exit 0/1 on pass/fail
```

### Maintenance

```bash
aap parse --all                                    # Rebuild metrics from traces
aap prune --older-than 30                          # Clean up old data
```

## Files Reference

| File                                  | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `docs/validation-architecture.md`     | This document                                           |
| `docs/VALIDATION.md`                  | StackPilot-specific validation guide                    |
| `docs/CACHE-BENCHMARK-METHODOLOGY.md` | Cache behavior and fair-benchmark approaches            |
| `benchmarks/run.sh`                   | Benchmark runner shell script                           |
| `benchmarks/validate.mjs`             | Statistical validation (bootstrap, CI, non-inferiority) |
| `benchmarks/baselines.mjs`            | Aggregate baseline collector                            |
| `benchmarks/recompute.mjs`            | Re-parse traces with corrected cost model               |
| `benchmarks/regressions.toml`         | Regression threshold configuration                      |
| `benchmarks/agents.toml`              | Agent adapter registry                                  |
| `benchmarks/fixtures/`                | Bundled benchmark fixtures                              |
| `benchmarks/reference/`               | Hidden reference files for grading                      |
| `benchmarks/rubrics/`                 | HITL scoring rubrics (future)                           |
| `src/cli/check.ts`                    | Regression check CLI command                            |
| `src/recommend/recommend.ts`          | Anomaly detection engine                                |
| `src/analyze/`                        | Cache-regen, command classification, search-read        |
| `src/store/store.ts`                  | SQLite schema and queries                               |
| `src/config/schema.ts`                | Zod schema for config.toml                              |
