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

By default the tasks run against the bundled **`benchmarks/fixture/`** — a tiny
zero-dependency CSV parser with a **deliberate bug** (the header row is parsed as a data
row, so `npm test` has one failing test). It's small enough to reason about but real enough
to exercise reading, searching, editing, and the test-fix loop. It's self-contained, so
cross-agent runs are comparable.

You can point the benchmark at other code instead:

| Target             | Flag               | Use it for                                             |
| ------------------ | ------------------ | ------------------------------------------------------ |
| Bundled fixture    | _(default)_        | Reproducible cross-agent comparison + a verifiable fix |
| Your own directory | `--dir <path>`     | Benchmarking on your real project                      |
| A cloned repo      | `--repo <git-url>` | A shared, downloadable target (shallow-cloned)         |

In every case the target is **copied fresh into a scratch dir per task**, so edits never
touch the original and each run starts from the same state.

## Tasks

Built-in tasks for the **fixture**:

| id            | stresses                                | prompt (summary)                                        |
| ------------- | --------------------------------------- | ------------------------------------------------------- |
| `explain`     | read patterns, context pulled in        | Explain the project + how `parser.js` works (read-only) |
| `locate`      | search/grep token cost                  | Find where `parseLine` is defined and used (read-only)  |
| `fix-bug`     | tool-call loop, iteration, verification | Fix the failing test                                    |
| `add-feature` | multi-file edit + test                  | Add a `trim` option to `parse()` and test it            |

For a **custom target** (`--dir`/`--repo`) the built-in fixture tasks don't apply, so
`run.sh` falls back to two generic read-only tasks (`explain`, `locate`). To run your own
tasks against any target, pass a task file:

```
./benchmarks/run.sh opencode --dir ~/my/project --tasks benchmarks/tasks.example.txt
```

A task file is one task per line as `id|prompt` (see `benchmarks/tasks.example.txt`).

## How `run.sh` works

`./benchmarks/run.sh <agent> [target] [--tasks file] [--dry-run]`:

1. Maps the agent to its headless flag (`opencode run "…"`, `claude -p "…"`).
2. Resolves the target source dir (fixture, `--dir`, or a shallow `--repo` clone).
3. For each task: wipes the scratch dir, copies the target in fresh, drops any `.git`, then
   runs `aap run --meta task=<id> --meta agent=<name> <agent> <flag> "<prompt>"` from inside
   the scratch dir. `aap run` injects proxy routing and registers the tagged session, so the
   profiler captures the whole run.
4. Prints the next steps.

Use `--dry-run` to print the exact commands without executing them.

## Running

1. Start the proxy in one terminal:
   ```
   aap serve
   ```
2. Make sure the agent is installed and its key is configured (opencode auth.json /
   `DEEPSEEK_API_KEY`, or Claude Code's `ANTHROPIC_API_KEY`). `aap run` handles routing
   through the proxy automatically.
3. Run the suite for an agent:
   ```
   ./benchmarks/run.sh opencode                 # bundled fixture
   ./benchmarks/run.sh opencode --dir ~/proj    # your project
   ./benchmarks/run.sh claude  --repo https://github.com/you/repo   # a cloned repo
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
