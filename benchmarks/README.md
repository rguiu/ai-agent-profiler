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

## The fixture

`benchmarks/fixture/` is a tiny zero-dependency CSV parser with a **deliberate bug** (the
header row is parsed as a data row, so `npm test` has one failing test). It's small enough
to reason about but real enough to exercise reading, searching, editing, and test-fix loops.

Each task runs against a **fresh copy** of the fixture in a scratch dir, so runs are
reproducible and never touch the repo.

## Tasks

| id            | stresses                                | prompt (summary)                                        |
| ------------- | --------------------------------------- | ------------------------------------------------------- |
| `explain`     | read patterns, context pulled in        | Explain the project + how `parser.js` works (read-only) |
| `locate`      | search/grep token cost                  | Find where `parseLine` is defined and used (read-only)  |
| `fix-bug`     | tool-call loop, iteration, verification | Fix the failing test                                    |
| `add-feature` | multi-file edit + test                  | Add a `trim` option to `parse()` and test it            |

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
   ./benchmarks/run.sh opencode
   # tomorrow, on a machine with Claude Code:
   ./benchmarks/run.sh claude
   ```
   Every task is launched as `aap run --meta task=<id> --meta agent=<name> <agent> …`, so the
   sessions are tagged.

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
