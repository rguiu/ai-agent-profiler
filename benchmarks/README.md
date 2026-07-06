# Benchmarks

A controlled way to compare how different coding agents (opencode, Claude Code, and
eventually AISH) execute the **same** tasks against the **same** codebase — so AISH design
decisions can be backed by measured profiler data instead of guesses.

## What it measures

Each task run is captured as a tagged profiler session. After parsing you can compare, per
task and per agent:

- total **requests**, **input/output tokens**, **cost**
- **tool calls** and distinct tools used
- **tool-result token amplification** (how much tool output entered context)
- **context growth** and **duplicated static context** (system prompt + tool defs re-sent)
- number of **recommendations** the profiler raised

## Where the tasks run (the target project)

Benchmarks run against a **fixture** — a small, self-contained mini-repo committed under
`benchmarks/fixtures/<name>/`, each with its own `TASKS` file and (where relevant) a
**verifiable** outcome (`npm test` with a deliberately planted failing test). Fixtures are
committed and pinned, so runs are reproducible and comparable across agents. That — not
cloning random public repos — is what makes a benchmark "proper": bounded, reproducible,
with ground truth.

Bundled fixtures:

| fixture      | shape                                   | stresses                                        |
| ------------ | --------------------------------------- | ----------------------------------------------- |
| `csv-parser` | one small module + tests, 1 planted bug | reading, fixing, a small edit                   |
| `task-queue` | multi-file lib (queue/scheduler/store)  | cross-file reasoning, locating logic, fix + add |
| `big-file`   | one ~220-line module (data + funcs)     | whole-file vs ranged reads (read amplification) |
| `many-files` | 40 tiny handler modules + a registry    | search / exploration cost (find the wrong file) |

Each fixture maps onto AISH capabilities the profiler measures: `big-file` → ranged reads
(#1) and result amplification (#3); `many-files` → repo-aware search (#2); all of them →
context growth (#6) and duplicated tool-def overhead (#5). See
[`docs/aish-requirements.md`](../docs/aish-requirements.md).

Pick one with `--fixture`:

```
./benchmarks/run.sh opencode --fixture task-queue
```

You can also point at other code (tasks then come from a `--tasks` file, or fall back to
generic read-only `explain`/`locate`):

| Target             | Flag               | Use it for                                             |
| ------------------ | ------------------ | ------------------------------------------------------ |
| Bundled fixture    | `--fixture <name>` | Reproducible cross-agent comparison + a verifiable fix |
| Your own directory | `--dir <path>`     | Profiling your real project                            |
| A cloned repo      | `--repo <git-url>` | A shared target (pin a commit for reproducibility)     |

Every target is **copied fresh into a scratch dir per task**, so edits never touch the
original and each run starts from the same state.

## Adding a fixture

1. Create `benchmarks/fixtures/<name>/` — a small, self-contained project. Prefer zero
   dependencies and a runnable check (e.g. `node --test`) so success is verifiable. Plant a
   clear, single bug for a `fix-bug` task.
2. Add a `TASKS` file next to it — one task per line as `id|prompt[|verify]`. The optional
   3rd field is a shell command run in the task's scratch dir after the agent finishes
   (exit 0 = pass), e.g. `npm test`. Keep read-only tasks explicit ("Do not change any files").
3. Run it: `./benchmarks/run.sh opencode --fixture <name>`.

Design fixtures to stress the things the profiler measures: whole-file vs ranged reads
(amplification), search cost (`locate`), context growth over a multi-step task, and tool
definitions re-sent every request.

## Tasks

Each fixture defines its own tasks in `TASKS`. The bundled fixtures use this shape:

| id            | stresses                                | outcome                     |
| ------------- | --------------------------------------- | --------------------------- |
| `explain`     | read patterns, context pulled in        | read-only                   |
| `locate`      | search / grep token cost                | read-only                   |
| `fix-bug`     | tool-call loop, iteration, verification | `npm test` passes           |
| `add-feature` | multi-file edit + test                  | new behaviour + test passes |

To run your own tasks against any target, pass a file (one `id|prompt` per line — see
`benchmarks/tasks.example.txt`):

```
./benchmarks/run.sh opencode --dir ~/my/project --tasks benchmarks/tasks.example.txt
```

## How `run.sh` works

`./benchmarks/run.sh <agent> [target] [--tasks file] [--verify cmd] [--no-verify] [--dry-run]`:

1. Maps the agent to its headless, auto-approving invocation: opencode →
   `opencode run --auto`, claude → `claude -p --dangerously-skip-permissions`. Without
   auto-approval the agent's edit/bash tools are rejected in non-interactive mode, so the
   `fix-bug`/`add-feature` tasks can't act.
2. Resolves the target source dir (`--fixture` name, `--dir`, or a shallow `--repo` clone).
3. Resolves tasks: `--tasks` file, else the target's own `TASKS`, else generic read-only tasks.
4. For each task: copies the target into its **own** scratch dir (`/tmp/aap-bench/<task>`),
   drops `.git`/`TASKS`, then runs
   `aap run --meta task=<id> --meta agent=<name> <agent> <invoke> "<prompt>"` from inside it,
   pinning the session id via `AAP_SESSION_ID` so it can be tagged afterwards.
   A separate dir per task matters: agents group sessions by project directory, so a shared
   path would bleed one task's conversation into the next.
5. **Verify (scoring):** if the task has a verify command (3rd `TASKS` field, or `--verify`
   default), it runs in the scratch dir after the agent finishes. Exit 0 → `pass`, else
   `fail`. The result is tagged onto the profiler session (`aap tag <sid> verify=pass|fail`)
   and written to `/tmp/aap-bench/results.tsv`, and a pass/fail summary prints at the end.
   `--no-verify` skips this. Read-only tasks (`explain`/`locate`) have no verify command.

Use `--dry-run` to print the exact commands (including the verify step) without executing them.

## Running

1. Start the proxy in one terminal:
   ```
   AWS_PROFILE=claude aap serve
   ```
2. Make sure the agent is installed and its key is configured (opencode auth.json /
   `DEEPSEEK_API_KEY`, or Claude Code with `CLAUDE_CODE_USE_BEDROCK=1`). `aap run` handles
   routing through the proxy automatically.
3. Run a fixture for an agent with a tag:
   ```
   ./benchmarks/run.sh claude --fixture task-queue --tag baseline
   ```
   Every task is launched tagged with `--meta task=<id> --meta agent=<name> --meta run=<tag>`.

## Example: A/B comparison (baseline vs optimize)

```bash
# Terminal 1 — baseline run
AWS_PROFILE=claude aap serve
# Terminal 2
./benchmarks/run.sh claude --fixture task-queue --tag baseline

# Terminal 1 — restart with optimize
AWS_PROFILE=claude aap serve --optimize
# Terminal 2
./benchmarks/run.sh claude --fixture task-queue --tag optimize

# Compare
aap compare --run baseline --run optimize
```

Output:
```
  ╭─ baseline vs optimize ─╮

  [explain]
                   baseline  optimize      Δ
  ──────────────────────────────────────────
  Requests                4         4      =
  Input tokens          558       558      =
  Output tokens          64       425  +564%
  Cost              $0.0757   $0.1411   +87%
  Tool calls              1         5  +400%
  ...

  TOTAL
                  baseline  optimize      Δ
  ─────────────────────────────────────────
  Requests              24        25    +4%
  Input tokens       1,792     1,790      =
  Cost             $0.7083   $0.8597   +21%
  Tool calls            12        19   +58%
  Wall time          90.7s    107.4s   +18%
```

## Comparing

```
aap compare --run baseline --run optimize    # full A/B across all tasks
aap compare --task fix-bug                   # all fix-bug sessions
aap compare --task fix-bug --run baseline    # just fix-bug from baseline
```

To roll every task up into a baseline report (mean per metric per agent, counting only
`verify=pass` runs for mutating tasks), run the collector:

```
node benchmarks/baselines.mjs            # writes benchmarks/BASELINES.md
node benchmarks/baselines.mjs fix-bug    # a subset of tasks
```

Those numbers are what fill the `Baseline:` slots in
[`docs/aish-requirements.md`](../docs/aish-requirements.md).

Sessions from a verified task are tagged `verify=pass|fail`, so you can filter baselines by
task success (e.g. via the `raw_sql` MCP tool or `aap sessions`) — a token win only counts if
the agent still solved the task.

Or open the dashboard at `http://localhost:8080/ui`, pick a session, and read its
**Recommendations** and **Context cost**. For a shareable writeup:

```
aap export <session-id>        # Markdown report
```

## Notes & honesty

- Agents are non-deterministic — run each task a few times (`AAP_META_iter` / repeated runs)
  and compare distributions, not single points.
- Token counts for tool results and context composition are **estimates** (~chars/4); they're
  reliable for _relative_ comparison between agents, not billing-exact.
- Success is auto-verified via each task's verify command (`npm test` for the bundled
  fixtures) and tagged onto the session as `verify=pass|fail`. A metric improvement only
  counts when `verify=pass` — never trade task success for token savings.
