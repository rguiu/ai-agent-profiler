#!/bin/sh
# Run a benchmark task suite through one agent, each run captured as a tagged
# profiler session (aap run --meta task=<id> --meta agent=<name>).
#
# Usage:
#   ./benchmarks/run.sh <agent> [target] [options]
#
#   <agent>              opencode | claude | stackpilot
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
#   --save-artifacts     copy each task's produced files into benchmarks/runs/<run>/artifacts/
#                        (a snapshot of the agent's output, before verification runs)
#   --prune --tag <name>  remove a previous run: deletes runs/<tag>/ and its sessions
#                        from the profiler. Useful before re-running with the same --tag.
#   --dry-run            print the commands instead of running them
#   -h, --help           show this help
#
# Prereqs: `aap serve` running; the agent installed with its API key configured; `aap` on
# PATH. Each task runs against a FRESH copy in a scratch dir, so edits never touch the source.
set -eu

usage() { sed -n '2,/^set -eu/p' "$0" | sed '/^set -eu/d; s/^# \{0,1\}//'; }

AGENT=""; FIXTURE="csv-parser"; REPO=""; DIR=""; TASKS_FILE=""; DRY=0
DEFAULT_VERIFY=""; NOVERIFY=0; TAG=""; SAVE_ARTIFACTS=0; PRUNE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fixture) FIXTURE="${2:?--fixture needs a name}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a git url}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --tasks) TASKS_FILE="${2:?--tasks needs a file}"; shift 2 ;;
    --verify) DEFAULT_VERIFY="${2:?--verify needs a command}"; shift 2 ;;
    --no-verify) NOVERIFY=1; shift ;;
    --tag) TAG="${2:?--tag needs a value (e.g. baseline, optimize)}"; shift 2 ;;
    --save-artifacts) SAVE_ARTIFACTS=1; shift ;;
    --prune) PRUNE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) if [ -z "$AGENT" ]; then AGENT="$1"; shift; else echo "unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"

# Verify commands may use `node --test --test-isolation=none`, which requires
# Node >=22; an older/default `node` silently fails with `node: bad option`,
# scoring every task fail with 0/0 tests and masking whether the agent actually
# solved anything. But `aap` itself is linked against a specific Node ABI
# (better-sqlite3) and breaks on a mismatched major — so we must NOT globally
# hijack PATH. Instead resolve a separate Node >=22 just for verify subprocesses
# and expose its bin dir as VERIFY_NODE_BIN; `aap` keeps using the ambient node.
node_major() { "$1" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
VERIFY_NODE_BIN=""
CUR_MAJOR="$(node_major node 2>/dev/null || echo 0)"
if [ "${CUR_MAJOR:-0}" -ge 22 ] 2>/dev/null; then
  : # ambient node already fine for verify
else
  BEST_NODE=""; BEST_MAJOR=0
  for cand in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/state/fnm_multishells/*/bin/node \
    "$HOME"/Library/Caches/fnm_multishells/*/bin/node \
    /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$cand" ] || continue
    m="$(node_major "$cand")"; [ -n "$m" ] || continue
    if [ "$m" -ge 22 ] && [ "$m" -gt "$BEST_MAJOR" ]; then BEST_MAJOR="$m"; BEST_NODE="$cand"; fi
  done
  if [ -n "$BEST_NODE" ]; then
    VERIFY_NODE_BIN="$(dirname "$BEST_NODE")"
    echo "run.sh: verify will use Node $("$BEST_NODE" -v) from $VERIFY_NODE_BIN"
  else
    echo "run.sh: WARNING — no Node >=22 found; verify with --test-isolation=none will fail" >&2
  fi
fi

# --prune deletes a previous run's directory and its tracked sessions.
if [ "$PRUNE" = "1" ]; then
  [ -n "$TAG" ] || { echo "error: --prune requires --tag" >&2; exit 1; }
  RUN_DIR="$HERE/runs/$TAG"
  RESULTS_FILE="$RUN_DIR/results.tsv"
  [ -f "$RESULTS_FILE" ] || { echo "error: no results found for tag '$TAG' ($RUN_DIR)" >&2; exit 1; }
  echo "pruning tag=$TAG ..."
  while IFS="$(printf '\t')" read -r tid tagent tstatus tsid; do
    [ -n "$tsid" ] || continue
    echo "  removing session $tsid"
    aap sessions rm "$tsid" 2>/dev/null || true
  done < "$RESULTS_FILE"
  rm -rf "$RUN_DIR"
  echo "done. removed $RUN_DIR and its sessions."
  exit 0
fi

[ -n "$AGENT" ] || { usage; exit 1; }

case "$AGENT" in
  opencode) INVOKE="run --auto" ;;
  claude)   INVOKE="-p --dangerously-skip-permissions" ;;
  stackpilot) INVOKE="-p --yolo" ;;
  *) echo "unknown agent: $AGENT (use opencode, claude, or stackpilot)" >&2; exit 1 ;;
esac

SCRATCH="${AAP_BENCH_SCRATCH:-/tmp/aap-bench}"

# Tasks launch `aap run` from a scratch dir, where a project-local ./config.toml
# would not resolve. Pin the project's config.toml (one level up from here) so runs
# work regardless of cwd — unless the caller already set AAP_CONFIG, or a home
# config (~/.aap/config.toml) exists.
if [ -z "${AAP_CONFIG:-}" ] && [ ! -f "$HOME/.aap/config.toml" ] && [ -f "$HERE/../config.toml" ]; then
  AAP_CONFIG="$(cd "$HERE/.." && pwd)/config.toml"
  export AAP_CONFIG
fi

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

# Hidden reference files for grading agent-authored code (kept OUTSIDE the copied
# fixture tree so answers don't leak). A task's verify line references them via
# $AAP_BENCH_REF, e.g. `cp "$AAP_BENCH_REF"/methods.test.js test/ && node --test ...`.
AAP_BENCH_REF=""
if [ -z "$REPO" ] && [ -z "$DIR" ] && [ -d "$HERE/reference/$FIXTURE" ]; then
  AAP_BENCH_REF="$HERE/reference/$FIXTURE"
fi
export AAP_BENCH_REF

# Each run gets a directory under benchmarks/runs/ that stores results, artifacts,
# verify logs, and a final report — always, not just with --save-artifacts.
# If --tag is given the directory is runs/<tag> (fails if it already exists).
# Without --tag a timestamp suffix guarantees uniqueness.
RUN_STAMP="$(date +%Y%m%d%H%M%S)"
if [ -n "$TAG" ]; then
  RUNS_ROOT="$HERE/runs/$TAG"
else
  RUNS_ROOT="$HERE/runs/run-$RUN_STAMP"
fi

RESULTS="$RUNS_ROOT/results.tsv"
TASK_N=0
TASK_TOTAL=0
VERIFIED=0
RUN_START=$(date +%s)
[ "$DRY" = "1" ] || {
  if [ -d "$RUNS_ROOT" ]; then
    echo "error: run directory already exists: $RUNS_ROOT" >&2
    echo "       remove it or use a different --tag" >&2
    exit 1
  fi
  mkdir -p "$SCRATCH" "$RUNS_ROOT"
  : > "$RESULTS"
}

# Count total tasks for progress display
if [ -n "$TASKS_FILE" ]; then
  TASK_TOTAL=$(grep -cv '^\(#\|$\)' "$TASKS_FILE" 2>/dev/null || echo 0)
else
  TASK_TOTAL=2
fi

# Preflight: verification pins the session id (AAP_SESSION_ID) and tags the result
# via `aap tag` — both need a current build. Warn early rather than after LLM calls.
if [ "$NOVERIFY" != "1" ] && [ "$DRY" != "1" ]; then
  if ! aap help 2>/dev/null | grep -q "aap tag"; then
    echo "warning: your installed 'aap' has no 'tag' command, so verify results won't be" >&2
    echo "         recorded on sessions. Rebuild it: 'npm run build' (re-link if needed)," >&2
    echo "         or pass --no-verify to skip scoring." >&2
  fi
fi

# Parse "pass/total" from a marked section of a node --test TAP log by reading its
# footer (`# pass N` / `# tests N`). $1=log, $2=section start marker, $3=end marker
# (empty = read to EOF). A SIGKILLed/OOM run has no footer -> "0/0".
count_section() {
  awk -v start="$2" -v end="$3" '
    index($0, start) { insec=1; next }
    end != "" && index($0, end) { insec=0 }
    insec && $1=="#" && $2=="pass"  { pass=$3 }
    insec && $1=="#" && $2=="tests" { total=$3 }
    END { printf "%d/%d", pass+0, total+0 }
  ' "$1" 2>/dev/null
}

# Format a "pass/total" result for the report. When total is 0 the test suite
# produced no TAP footer — distinguish a runner that errored/timed out (wrong
# Node `bad option`, OOM, crash, or a hung suite SIGKILLed by the verify
# timeout) from a genuinely empty section, so a broken harness or an infinite
# loop in the agent's code never silently looks like "no tests".
# $1=pass/total, $2=log, $3=section start marker, $4=section end marker.
fmt_test_result() {
  result="$1"; log="$2"; start="$3"; end="$4"
  case "$result" in
    */0)
      # Explicit runtime failures anywhere in the log.
      if grep -qiE "bad option|Fatal|FATAL|out of memory|heap limit|Cannot find module|MODULE_NOT_FOUND" "$log" 2>/dev/null; then
        echo "not run (error)"
        return
      fi
      # Section had content (tests started) but no footer → killed mid-run,
      # typically a hang SIGKILLed by the verify timeout.
      section_lines=$(awk -v s="$start" -v e="$end" '
        index($0,s){insec=1;next} e!=""&&index($0,e){insec=0}
        insec{c++} END{print c+0}' "$log" 2>/dev/null)
      if [ "${section_lines:-0}" -gt 1 ]; then
        echo "did not finish (timeout/crash)"
      else
        echo "—"
      fi
      ;;
    *) echo "$result passed" ;;
  esac
}

run_task() {
  id="$1"; prompt="$2"; verify="$3"
  [ -n "$verify" ] || { [ "$NOVERIFY" = "1" ] || verify="$DEFAULT_VERIFY"; }
  [ "$NOVERIFY" = "1" ] && verify=""
  scratch="$SCRATCH/$id"
  TASK_N=$((TASK_N + 1))
  sid="bench-${AGENT}-${id}-${RUN_STAMP}-${TASK_N}"
  META_ARGS="--meta task=$id --meta agent=$AGENT"
  [ -n "$TAG" ] && META_ARGS="$META_ARGS --meta run=$TAG"

  if [ "$DRY" = "1" ]; then
    echo "[$TASK_N/$TASK_TOTAL] $id  (cd $scratch && AAP_SESSION_ID=$sid aap run $META_ARGS $AGENT $INVOKE \"$prompt\")"
    [ "$SAVE_ARTIFACTS" = "1" ] && echo "      artifacts -> $RUNS_ROOT/artifacts/$id/"
    [ -n "$verify" ] && echo "      verify: (cd $scratch && $verify) && aap tag $sid verify=pass"
    [ -n "$AAP_BENCH_REF" ] && echo "      (AAP_BENCH_REF=$AAP_BENCH_REF)"
    return 0
  fi
  rm -rf "$scratch"; mkdir -p "$scratch"; cp -R "$SRC"/. "$scratch"; rm -rf "$scratch/.git" "$scratch/TASKS"
  elapsed=$(( $(date +%s) - RUN_START ))
  printf '\n\033[1m[%d/%d] %s\033[0m  agent=%s%s  elapsed=%dm%02ds\n' \
    "$TASK_N" "$TASK_TOTAL" "$id" "$AGENT" "${TAG:+ tag=$TAG}" $((elapsed/60)) $((elapsed%60))
  echo "    scratch=$scratch"
  ( cd "$scratch" && AAP_SESSION_ID="$sid" aap run $META_ARGS "$AGENT" $INVOKE "$prompt" </dev/null ) || true

  # Snapshot the agent's produced files BEFORE verify copies in any reference files.
  if [ "$SAVE_ARTIFACTS" = "1" ]; then
    dest="$RUNS_ROOT/artifacts/$id"
    mkdir -p "$dest"
    cp -R "$scratch"/. "$dest"/ 2>/dev/null || true
    rm -rf "$dest/.git"
    echo "    artifacts=$dest"
  fi

  [ -n "$verify" ] || return 0
  echo ">>> verify [$id]: $verify"
  verify_log="$scratch/.verify.log"
  # Run verify with the resolved Node >=22 prepended to PATH (only for this
  # subprocess), so `node --test --test-isolation=none` works without breaking
  # the ambient `aap` (which is linked against a different Node ABI).
  if ( cd "$scratch" && PATH="${VERIFY_NODE_BIN:+$VERIFY_NODE_BIN:}$PATH" eval "$verify" >"$verify_log" 2>&1 ); then
    status=pass
  else
    status=fail
  fi
  echo "    verify=$status  (log: $verify_log)"
  mkdir -p "$RUNS_ROOT/verify"
  cp "$verify_log" "$RUNS_ROOT/verify/$id.log"

  # Count fixture and reference test-suite results from the verify log footers.
  fixture=$(count_section "$verify_log" "=== FIXTURE TESTS ===" "=== EDGE TESTS ===")
  edge=$(count_section "$verify_log" "=== EDGE TESTS ===" "")

  if ! aap tag "$sid" "verify=$status" "fixture=$fixture" "edge=$edge" >/dev/null 2>&1; then
    echo "    warning: could not tag session $sid — the session is recorded but not"
    echo "             marked verify=$status. Ensure 'aap' is rebuilt (npm run build)"
    echo "             so it supports 'aap tag' + AAP_SESSION_ID, then: aap tag <id> verify=$status"
  fi
  printf '%s\t%s\t%s\t%s\n' "$id" "$AGENT" "$status" "$sid" >> "$RESULTS"
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
total_elapsed=$(( $(date +%s) - RUN_START ))
printf '\n\033[1m✓ Benchmark complete\033[0m  %d task(s) in %dm%02ds\n' \
  "$TASK_N" $((total_elapsed/60)) $((total_elapsed%60))

REPORT="$RUNS_ROOT/report.md"
if [ "$DRY" != "1" ]; then
  mkdir -p "$RUNS_ROOT"

  # Parse traces into SQLite so session metrics are available for the report.
  echo ">>> parsing traces ..."
  aap parse >/dev/null 2>&1 || true

  # Export per-task session data as JSON (includes metrics + optimize + recommendations).
  mkdir -p "$RUNS_ROOT/metrics"
  n=1
  while IFS="$(printf '\t')" read -r tid tagent tstatus tsid; do
    aap export --json "$tsid" > "$RUNS_ROOT/metrics/$tid.json" 2>/dev/null || true
    n=$((n + 1))
  done < "$RESULTS"

  # Inline node helper to extract metrics + optimize from an export JSON file.
  # Outputs a tab-separated line: requests\tinput\tcached\toutput\tcost\ttools\twall\toptimize_json
  extract_metrics() {
    node -e '
      const fs = require("fs");
      const raw = fs.readFileSync(process.argv[1], "utf8");
      if (!raw.trim()) { console.log(""); process.exit(0); }
      const d = JSON.parse(raw);
      const reqs = (d.requests || []).length;
      const input = (d.requests || []).reduce((a, r) => a + (r.input_tokens || 0), 0);
      const output = (d.requests || []).reduce((a, r) => a + (r.output_tokens || 0), 0);
      const cached = d.analysis?.context?.cached_input_tokens_total || 0;
      const cost = (d.requests || []).reduce((a, r) => a + (r.cost || 0), 0);
      const tools = (d.requests || []).reduce((a, r) => a + (r.tool_call_count || 0), 0);
      const starts = (d.requests || []).map(r => r.started_at ? Date.parse(r.started_at) : NaN).filter(t => !isNaN(t));
      const ends   = (d.requests || []).map(r => r.ended_at   ? Date.parse(r.ended_at)   : NaN).filter(t => !isNaN(t));
      const wall = (starts.length && ends.length) ? ((Math.max(...ends) - Math.min(...starts)) / 1000).toFixed(1) + "s" : "—";
      const optimize = d.optimize || [];
      const recs = (d.recommendations || []).length;
      const parts = [
        reqs, input, cached, output, cost.toFixed(4), tools, wall, recs,
        JSON.stringify(optimize)
      ];
      console.log(parts.join("\t"));
    ' "$1" 2>/dev/null
  }

  # Build report header.
  {
    echo "# Benchmark Run Report"
    echo
    echo "| Field | Value |"
    echo "|-------|-------|"
    echo "| Agent | $AGENT |"
    [ -n "$TAG" ] && echo "| Tag | $TAG |"
    [ -n "$FIXTURE" ] && echo "| Fixture | $FIXTURE |"
    [ -n "$REPO" ]   && echo "| Repo | $REPO |"
    [ -n "$DIR" ]    && echo "| Dir | $DIR |"
    [ -n "$TASKS_FILE" ] && echo "| Tasks file | $TASKS_FILE |"
    echo "| Timestamp | $(date -r "$RUN_START" '+%Y-%m-%d %H:%M:%S') |"
    echo "| Elapsed | ${total_elapsed}s ($((total_elapsed/60))m$((total_elapsed%60))s) |"
    echo "| Tasks run | $TASK_N |"
    echo

    if [ "$VERIFIED" -gt 0 ]; then
      passed=$(awk -F'\t' '$3=="pass"' "$RESULTS" | wc -l | tr -d ' ')
      failed=$((VERIFIED - passed))
      echo "## Results"
      echo
      echo "| # | Task | Agent | Status | Fixture tests | Edge-case tests |"
      echo "|---|------|-------|--------|---------------|-----------------|"
      n=1
      while IFS="$(printf '\t')" read -r tid tagent tstatus; do
        vlog="$RUNS_ROOT/verify/$tid.log"
        fixture=$(count_section "$vlog" "=== FIXTURE TESTS ===" "=== EDGE TESTS ===")
        edge=$(count_section "$vlog" "=== EDGE TESTS ===" "")
        fix_str=$(fmt_test_result "$fixture" "$vlog" "=== FIXTURE TESTS ===" "=== EDGE TESTS ===")
        ref_str=$(fmt_test_result "$edge" "$vlog" "=== EDGE TESTS ===" "")
        echo "| $n | $tid | $tagent | $tstatus | $fix_str | $ref_str |"
        n=$((n + 1))
      done < "$RESULTS"
      echo
      echo "**Passed:** $passed / $VERIFIED  **Failed:** $failed / $VERIFIED"
      echo

      # Per-task metrics from session data.
      echo "## Session Metrics"
      echo
      echo "| Task | Requests | Input tok | Cached tok | Output tok | Cost | Tool calls | Wall time | Recs |"
      echo "|------|---------:|----------:|-----------:|-----------:|-----:|-----------:|----------:|-----:|"
      n=1
      optimize_all=""
      while IFS="$(printf '\t')" read -r tid tagent tstatus tsid; do
        metrics=$(extract_metrics "$RUNS_ROOT/metrics/$tid.json")
        if [ -n "$metrics" ]; then
          IFS="$(printf '\t')" read -r reqs inp cach outp cost tools wall recs optjson <<EOFMETRICS
$metrics
EOFMETRICS
          echo "| $tid | $reqs | $(echo "$inp" | awk '{printf "%\047d", $1}' 2>/dev/null || echo "$inp") | $(echo "$cach" | awk '{printf "%\047d", $1}' 2>/dev/null || echo "$cach") | $(echo "$outp" | awk '{printf "%\047d", $1}' 2>/dev/null || echo "$outp") | \$$cost | $tools | $wall | $recs |"
          # Collect optimize entries for later rendering.
          if [ -n "$optjson" ] && [ "$optjson" != "[]" ]; then
            optimize_all="${optimize_all}${tid}	${optjson}
"
          fi
        else
          echo "| $tid | — | — | — | — | — | — | — | — |"
        fi
        n=$((n + 1))
      done < "$RESULTS"
      echo

      # Optimizations section (rendered from collected optimize data).
      if [ -n "$optimize_all" ]; then
        echo "## Optimizations"
        echo
        echo "| Task | Strategy | Actions | Tokens saved |"
        echo "|------|----------|--------:|-------------:|"
        printf '%s' "$optimize_all" | while IFS="$(printf '\t')" read -r otid ojson; do
          [ -z "$ojson" ] && continue
          echo "$ojson" | node -e '
            const items = JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));
            items.forEach(o => {
              const tn = String(o.tokens_saved || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
              console.log(`| '"$otid"' | ${o.type} | ${o.count || 0} | ~${tn} |`);
            });
          ' 2>/dev/null
        done
        echo
      fi
    fi

    if [ "$SAVE_ARTIFACTS" = "1" ]; then
      echo "## Artifacts"
      echo
      echo "Agent-produced files saved to: \`$RUNS_ROOT/artifacts/\`"
      echo
    fi

    echo "## Session IDs"
    echo
    echo "| Task | Session ID |"
    echo "|------|------------|"
    n=1
    while IFS="$(printf '\t')" read -r tid tagent tstatus tsid; do
      echo "| $tid | \`$tsid\` |"
      n=$((n + 1))
    done < "$RESULTS"
    echo
    echo "---"
    echo "*Generated by \`benchmarks/run.sh\` — all data under \`$RUNS_ROOT\`*"
  } > "$REPORT"
  echo "  Run dir: $RUNS_ROOT"
  echo "  Report:  $REPORT"
fi

if [ "$DRY" != "1" ] && [ "$VERIFIED" -gt 0 ]; then
  passed=$(awk -F'\t' '$3=="pass"' "$RESULTS" | wc -l | tr -d ' ')
  echo "  Verify: $passed/$VERIFIED passed"
  awk -F'\t' '{printf "    %-12s %-9s %s\n", $1, $2, $3}' "$RESULTS"
  echo
fi
echo "Next:"
echo "  aap compare --task <id>     # side-by-side once another agent has run the same tasks"
echo "  cat $REPORT                 # full benchmark report"
