#!/bin/sh
# A/B benchmark for the iterative-fix-plus fixture comparing wrapper-level optimizations
# (tool output filtering via ~/.aap/bin PATH wrappers) vs bare agent.
#
# Tests:
#   1. Baseline — no hooks, raw tool output
#   2. Hooks — tool output filtered (aap hook mode aggressive)
#
# Usage:
#   ./benchmarks/iterative-fix-ab.sh [agent] [--fixture NAME] [--port N] [--keep-serve]
#
#   agent          opencode (default) | claude
#   --fixture      fixture under benchmarks/fixtures/ (default: iterative-fix-plus)
#   --port         proxy port for this run (default: 8199, or $AAP_BENCH_PORT)
#   --scenario     which scenarios to run (default: "baseline hooks")
#                  comma-separated: baseline, hooks
#   --keep-serve   leave the proxy running at the end (for manual poking)
#
# Prereqs: `aap` built + on PATH; the agent installed with its API key; the
#   chosen port free. Run from anywhere.
set -eu

AGENT=opencode
FIXTURE=iterative-fix-plus
PORT="${AAP_BENCH_PORT:-8199}"
SCENARIOS="baseline,hooks"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fixture) FIXTURE="${2:?--fixture needs a name}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --scenario) SCENARIOS="${2:?--scenario needs a list}"; shift 2 ;;
    --keep-serve) KEEP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) AGENT="$1"; shift ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
HOST=127.0.0.1
BASE="http://$HOST:$PORT"
LOGDIR="${TMPDIR:-/tmp}/aap-ab"
mkdir -p "$LOGDIR"
export AAP_PORT="$PORT"

command -v aap >/dev/null 2>&1 || {
  echo "aap not on PATH — build and link it: npm run build && npm link" >&2; exit 1; }
[ -d "$HERE/fixtures/$FIXTURE" ] || {
  echo "no such fixture: $FIXTURE (see benchmarks/fixtures/)" >&2; exit 1; }
if curl -s -m1 "$BASE/health" >/dev/null 2>&1; then
  echo "port $PORT is already serving — pick another with --port N" >&2; exit 1
fi

SERVE_PID=""
stop_serve() {
  [ -n "$SERVE_PID" ] || return 0
  kill "$SERVE_PID" 2>/dev/null || true
  i=0; while [ $i -lt 50 ] && kill -0 "$SERVE_PID" 2>/dev/null; do sleep 0.1; i=$((i+1)); done
  SERVE_PID=""
}
cleanup() { [ "$KEEP" = "1" ] || stop_serve; }
trap cleanup EXIT INT TERM

# Install hooks once before all runs
aap hook install >/dev/null 2>&1 || true

start_serve() { # $1 = extra serve args
  local label="${1:-baseline}"
  aap serve $1 >"$LOGDIR/serve-${label}.log" 2>&1 &
  SERVE_PID=$!
  i=0
  while [ $i -lt 100 ]; do
    curl -s -m1 "$BASE/health" >/dev/null 2>&1 && return 0
    kill -0 "$SERVE_PID" 2>/dev/null || {
      echo "serve exited early — see $LOGDIR/serve-${label}.log" >&2; exit 1; }
    sleep 0.1; i=$((i+1))
  done
  echo "serve did not become healthy on $BASE — see $LOGDIR" >&2; exit 1
}

run_phase() { # $1 = scenario tag, $2 = hook mode, $3 = run args, $4 = serve args
  printf '\n\033[1m=== phase: %s (hook=%s serve=%s) ===\033[0m\n' "$1" "${2:-off}" "${4:-<none>}"
  start_serve "$4"

  aap hook mode "${2:-off}" >/dev/null 2>&1 || true

  "$HERE/run.sh" "$AGENT" \
    --fixture "$FIXTURE" \
    --tag "$1" \
    $3

  stop_serve
}

# --- Run scenarios ---
IFS=','; for scenario in $SCENARIOS; do
  case "$scenario" in
    baseline)
      run_phase baseline off "" "--no-optimize"
      ;;
    hooks)
      run_phase hooks aggressive "" "--no-optimize"
      ;;
    *)
      echo "unknown scenario: $scenario (valid: baseline, hooks)" >&2
      ;;
  esac
done

printf '\n\033[1m=== parse + compare ===\033[0m\n'
aap parse >/dev/null 2>&1 || true

IFS=','; for scenario in $SCENARIOS; do
  case "$scenario" in
    baseline) TAGS="${TAGS:+$TAGS }baseline" ;;
    hooks)    TAGS="${TAGS:+$TAGS }hooks" ;;                                                   
  esac
done

# List sessions per tag
for tag in $TAGS; do
  sid=$(aap sessions --json 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      let rows=[];try{rows=JSON.parse(s)}catch{}
      const hit=rows.find(r=>r.meta&&r.meta.run==='$tag');
      if(hit)process.stdout.write(hit.id);
    });" 2>/dev/null || true)
  printf '  %-12s %s\n' "$tag" "${sid:-<not found>}"
done

echo
echo "To compare: aap compare --run baseline --run hooks"
[ "$KEEP" = "1" ] && echo && echo "proxy still running on $BASE (pid $SERVE_PID)"
exit 0
