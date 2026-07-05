#!/bin/sh
# Run a benchmark task suite through one agent, each run captured as a tagged
# profiler session (aap run --meta task=<id> --meta agent=<name>).
#
# Usage:
#   ./benchmarks/run.sh <agent> [target] [options]
#
#   <agent>              opencode | claude
#
# Target (what codebase the tasks run against — default: fixture "csv-parser"):
#   --fixture <name>     a bundled fixture under benchmarks/fixtures/ (csv-parser, task-queue)
#   --dir  <path>        copy an existing local directory and run against it
#   --repo <git-url>     shallow-clone a repo and run against it (pin a commit for reproducibility)
#
# Tasks:
#   --tasks <file>       read tasks from a file, one per line as:  id|prompt
#   (none)               use the fixture's own TASKS file; for --dir/--repo without a
#                        TASKS file, fall back to generic read-only explain/locate tasks
#
# Other:
#   --dry-run            print the commands instead of running them
#   -h, --help           show this help
#
# Prereqs: `aap serve` running; the agent installed with its API key configured; `aap` on
# PATH. Each task runs against a FRESH copy in a scratch dir, so edits never touch the source.
set -eu

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; }

AGENT=""; FIXTURE="csv-parser"; REPO=""; DIR=""; TASKS_FILE=""; DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fixture) FIXTURE="${2:?--fixture needs a name}"; shift 2 ;;
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
  opencode) INVOKE="run" ;;
  claude)   INVOKE="-p"  ;;
  *) echo "unknown agent: $AGENT (use opencode or claude)" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="${AAP_BENCH_SCRATCH:-/tmp/aap-bench}"

# Resolve the source directory copied fresh for every task.
if [ -n "$REPO" ]; then
  SRC="${AAP_BENCH_SRC:-/tmp/aap-bench-src}"
  echo "cloning $REPO ..."; rm -rf "$SRC"; git clone --depth 1 "$REPO" "$SRC" >/dev/null 2>&1
elif [ -n "$DIR" ]; then
  SRC="$(cd "$DIR" && pwd)"
else
  SRC="$HERE/fixtures/$FIXTURE"
  [ -d "$SRC" ] || { echo "no such fixture: $FIXTURE (see benchmarks/fixtures/)" >&2; exit 1; }
fi

# Resolve tasks: explicit --tasks, else the source's own TASKS file, else generic.
if [ -z "$TASKS_FILE" ] && [ -f "$SRC/TASKS" ]; then TASKS_FILE="$SRC/TASKS"; fi

run_task() {
  id="$1"; prompt="$2"
  if [ "$DRY" = "1" ]; then
    echo "[$id] (cd $SCRATCH && aap run --meta task=$id --meta agent=$AGENT $AGENT $INVOKE \"$prompt\")"
    return
  fi
  rm -rf "$SCRATCH"; cp -R "$SRC" "$SCRATCH"; rm -rf "$SCRATCH/.git" "$SCRATCH/TASKS"
  echo ">>> task=$id agent=$AGENT src=$SRC"
  ( cd "$SCRATCH" && aap run --meta "task=$id" --meta "agent=$AGENT" "$AGENT" "$INVOKE" "$prompt" ) || true
}

if [ -n "$TASKS_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    run_task "${line%%|*}" "${line#*|}"
  done < "$TASKS_FILE"
else
  run_task explain "Explain what this project does and give an overview of its structure. Do not change any files."
  run_task locate "Identify the main entry point and the most important modules, with file paths. Do not change any files."
fi

echo
echo "Done. Next:"
echo "  aap parse"
echo "  aap compare --task <id>     # side-by-side once another agent has run the same tasks"
