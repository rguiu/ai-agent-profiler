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
#   --tasks <file>       read tasks from a file, one per line as:  id|prompt[|verify]
#                        an optional 3rd field is a shell command run in the task's scratch
#                        dir after the agent finishes; exit 0 = pass (e.g. "npm test").
#   (none)               use the fixture's own TASKS file; for --dir/--repo without a
#                        TASKS file, fall back to generic read-only explain/locate tasks
#
# Verify (score task success — did the agent's change actually work?):
#   --verify <cmd>       default verify command for tasks with no 3rd field
#   --no-verify          skip verification entirely
#                        Each verified session is tagged with verify=pass|fail (aap tag),
#                        so baselines can be filtered by task success.
#
# Other:
#   --dry-run            print the commands instead of running them
#   -h, --help           show this help
#
# Prereqs: `aap serve` running; the agent installed with its API key configured; `aap` on
# PATH. Each task runs against a FRESH copy in a scratch dir, so edits never touch the source.
set -eu

usage() { sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; }

AGENT=""; FIXTURE="csv-parser"; REPO=""; DIR=""; TASKS_FILE=""; DRY=0
DEFAULT_VERIFY=""; NOVERIFY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fixture) FIXTURE="${2:?--fixture needs a name}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a git url}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --tasks) TASKS_FILE="${2:?--tasks needs a file}"; shift 2 ;;
    --verify) DEFAULT_VERIFY="${2:?--verify needs a command}"; shift 2 ;;
    --no-verify) NOVERIFY=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) if [ -z "$AGENT" ]; then AGENT="$1"; shift; else echo "unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done

[ -n "$AGENT" ] || { usage; exit 1; }

case "$AGENT" in
  opencode) INVOKE="run --auto" ;;                       # opencode run --auto "<prompt>"
  claude)   INVOKE="-p --dangerously-skip-permissions" ;; # claude -p ... "<prompt>"
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

RUN_STAMP="$(date +%Y%m%d%H%M%S)"
RESULTS="$SCRATCH/results.tsv"
TASK_N=0
VERIFIED=0
[ "$DRY" = "1" ] || { mkdir -p "$SCRATCH"; : > "$RESULTS"; }

# Preflight: verification pins the session id (AAP_SESSION_ID) and tags the result
# via `aap tag` — both need a current build. Warn early rather than after LLM calls.
if [ "$NOVERIFY" != "1" ] && [ "$DRY" != "1" ]; then
  if ! aap help 2>/dev/null | grep -q "aap tag"; then
    echo "warning: your installed 'aap' has no 'tag' command, so verify results won't be" >&2
    echo "         recorded on sessions. Rebuild it: 'npm run build' (re-link if needed)," >&2
    echo "         or pass --no-verify to skip scoring." >&2
  fi
fi

run_task() {
  id="$1"; prompt="$2"; verify="$3"
  [ -n "$verify" ] || { [ "$NOVERIFY" = "1" ] || verify="$DEFAULT_VERIFY"; }
  [ "$NOVERIFY" = "1" ] && verify=""
  # A unique scratch dir per task keeps each run isolated: agents (e.g. opencode)
  # group sessions by project directory, so reusing one path would bleed context
  # from one task into the next.
  scratch="$SCRATCH/$id"
  TASK_N=$((TASK_N + 1))
  sid="bench-${AGENT}-${id}-${RUN_STAMP}-${TASK_N}"
  if [ "$DRY" = "1" ]; then
    echo "[$id] (cd $scratch && AAP_SESSION_ID=$sid aap run --meta task=$id --meta agent=$AGENT $AGENT $INVOKE \"$prompt\")"
    [ -n "$verify" ] && echo "      verify: (cd $scratch && $verify) && aap tag $sid verify=pass"
    return 0
  fi
  rm -rf "$scratch"; mkdir -p "$scratch"; cp -R "$SRC"/. "$scratch"; rm -rf "$scratch/.git" "$scratch/TASKS"
  echo ">>> task=$id agent=$AGENT scratch=$scratch"
  # stdin from /dev/null so the agent can't consume the task-loop's stdin (the TASKS file).
  # AAP_SESSION_ID pins the session so we can tag it with the verify result afterwards.
  ( cd "$scratch" && AAP_SESSION_ID="$sid" aap run --meta "task=$id" --meta "agent=$AGENT" "$AGENT" $INVOKE "$prompt" </dev/null ) || true

  [ -n "$verify" ] || return 0
  echo ">>> verify [$id]: $verify"
  if ( cd "$scratch" && eval "$verify" >"$scratch/.verify.log" 2>&1 ); then
    status=pass
  else
    status=fail
  fi
  echo "    verify=$status  (log: $scratch/.verify.log)"
  if ! aap tag "$sid" "verify=$status" >/dev/null 2>&1; then
    echo "    warning: could not tag session $sid — the session is recorded but not"
    echo "             marked verify=$status. Ensure 'aap' is rebuilt (npm run build)"
    echo "             so it supports 'aap tag' + AAP_SESSION_ID, then: aap tag <id> verify=$status"
  fi
  printf '%s\t%s\t%s\n' "$id" "$AGENT" "$status" >> "$RESULTS"
  VERIFIED=$((VERIFIED + 1))
}

if [ -n "$TASKS_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    id="${line%%|*}"; rest="${line#*|}"; prompt="$rest"; verify=""
    case "$rest" in *"|"*) prompt="${rest%%|*}"; verify="${rest#*|}" ;; esac
    run_task "$id" "$prompt" "$verify"
  done < "$TASKS_FILE"
else
  run_task explain "Explain what this project does and give an overview of its structure. Do not change any files." ""
  run_task locate "Identify the main entry point and the most important modules, with file paths. Do not change any files." ""
fi

echo
if [ "$DRY" != "1" ] && [ "$VERIFIED" -gt 0 ]; then
  passed=$(awk -F'\t' '$3=="pass"' "$RESULTS" | wc -l | tr -d ' ')
  echo "Verify results ($passed/$VERIFIED passed):"
  awk -F'\t' '{printf "  %-12s %-9s %s\n", $1, $2, $3}' "$RESULTS"
  echo "  (full table: $RESULTS)"
  echo
fi
echo "Done. Next:"
echo "  aap parse"
echo "  aap sessions                # sessions are tagged task=<id> agent=<name> verify=pass|fail"
echo "  aap compare --task <id>     # side-by-side once another agent has run the same tasks"
