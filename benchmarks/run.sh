#!/bin/sh
# Run a benchmark task suite through one agent, each run captured as a tagged
# profiler session (aap run --meta task=<id> --meta agent=<name>).
#
# Usage:
#   ./benchmarks/run.sh <agent> [target] [options]
#
#   <agent>            opencode | claude
#
# Target (what codebase the tasks run against — default: the bundled fixture):
#   --repo <git-url>   git clone the repo (shallow) and run against a fresh copy
#   --dir  <path>      copy an existing local directory and run against it
#   (none)             use benchmarks/fixture (a tiny CSV parser with a failing test)
#
# Tasks:
#   --tasks <file>     read tasks from a file, one per line as:  id|prompt
#                      (blank lines and lines starting with # are ignored)
#   (none)             built-in tasks: fixture -> explain/locate/fix-bug/add-feature
#                                      custom target -> generic explain/locate (read-only)
#
# Other:
#   --dry-run          print the commands instead of running them
#   -h, --help         show this help
#
# Prereqs: `aap serve` running; the agent installed with its API key configured;
# `aap` on PATH. Each task runs against a FRESH copy in a scratch dir, so edits
# never touch your project and every run starts from the same state.
set -eu

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

AGENT=""
REPO=""
DIR=""
TASKS_FILE=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a git url}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --tasks) TASKS_FILE="${2:?--tasks needs a file}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) if [ -z "$AGENT" ]; then AGENT="$1"; shift; else echo "unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done

[ -n "$AGENT" ] || { usage; exit 1; }

case "$AGENT" in
  opencode) INVOKE="run" ;;   # opencode run "<prompt>"
  claude)   INVOKE="-p"  ;;   # claude -p "<prompt>"
  *) echo "unknown agent: $AGENT (use opencode or claude)" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="${AAP_BENCH_SCRATCH:-/tmp/aap-bench}"

# Resolve the source directory that gets copied fresh for every task.
if [ -n "$REPO" ]; then
  SRC="${AAP_BENCH_SRC:-/tmp/aap-bench-src}"
  echo "cloning $REPO ..."
  rm -rf "$SRC"
  git clone --depth 1 "$REPO" "$SRC" >/dev/null 2>&1
elif [ -n "$DIR" ]; then
  SRC="$(cd "$DIR" && pwd)"
else
  SRC="$HERE/fixture"
fi

run_task() {
  id="$1"; prompt="$2"
  if [ "$DRY" = "1" ]; then
    echo "cp -R $SRC $SCRATCH && cd $SCRATCH && aap run --meta task=$id --meta agent=$AGENT $AGENT $INVOKE \"$prompt\""
    return
  fi
  rm -rf "$SCRATCH"
  cp -R "$SRC" "$SCRATCH"
  rm -rf "$SCRATCH/.git"
  echo ">>> task=$id agent=$AGENT src=$SRC"
  ( cd "$SCRATCH" && aap run --meta "task=$id" --meta "agent=$AGENT" "$AGENT" "$INVOKE" "$prompt" ) || true
}

if [ -n "$TASKS_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    run_task "${line%%|*}" "${line#*|}"
  done < "$TASKS_FILE"
elif [ -z "$REPO" ] && [ -z "$DIR" ]; then
  # Built-in fixture tasks (the fixture has a known failing test).
  run_task explain "Explain what this project does and how src/parser.js works. Do not change any files."
  run_task locate "Where is parseLine defined and where is it used? List files and line numbers. Do not change any files."
  run_task fix-bug "The test suite (npm test) has a failing test. Find and fix the bug in the source so all tests pass."
  run_task add-feature "Add a boolean 'trim' option to parse(options) that strips leading/trailing whitespace from each cell. Add a test and make sure npm test passes."
else
  # Custom target without a tasks file: generic read-only exploration tasks
  # (measure token/tool efficiency, not correctness).
  run_task explain "Explain what this project does and give an overview of its structure. Do not change any files."
  run_task locate "Identify the main entry point and the most important modules, with file paths. Do not change any files."
fi

echo
echo "Done. Next:"
echo "  aap parse"
echo "  aap compare --task <id>     # side-by-side once another agent has run the same tasks"
