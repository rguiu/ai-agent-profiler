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
2. Add a `TASKS` file next to it — one task per line as `id|prompt`. Keep read-only tasks
   explicit ("Do not change any files").
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

`./benchmarks/run.sh <agent> [target] [--tasks file] [--dry-run]`:

1. Maps the agent to its headless flag (`opencode run "…"`, `claude -p "…"`).
2. Resolves the target source dir (`--fixture` name, `--dir`, or a shallow `--repo` clone).
3. Resolves tasks: `--tasks` file, else the target's own `TASKS`, else generic read-only tasks.
4. For each task: wipes the scratch dir, copies the target in fresh, drops `.git`/`TASKS`,
   then runs `aap run --meta task=<id> --meta agent=<name> <agent> <flag> "<prompt>"` from
   inside the scratch dir. `aap run` injects proxy routing and registers the tagged session.

Use `--dry-run` to print the exact commands without executing them.

## Running

1. Start the proxy in one terminal:
   ```
   aap serve
   ```
2. Make sure the agent is installed and its key is configured (opencode auth.json /
   `DEEPSEEK_API_KEY`, or Claude Code's `ANTHROPIC_API_KEY`). `aap run` handles routing
   through the proxy automatically.
3. Run a fixture for an agent:
   ```
   ./benchmarks/run.sh opencode --fixture task-queue
   ```
   Every task is launched tagged with `--meta task=<id> --meta agent=<name>`.

## Comparing

```
aap parse                      # derive metrics for the new sessions
aap compare --task fix-bug     # side-by-side across every agent that ran fix-bug
aap compare --task explain
```

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
- Success (did the agent actually fix the bug?) is not auto-verified yet — check
  `npm test` in the scratch dir, or add a verify step. Automated verification is the next
  piece of full benchmark mode.
