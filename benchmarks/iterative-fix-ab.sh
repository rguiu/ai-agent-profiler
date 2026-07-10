#!/bin/sh
# A/B benchmark for the iterative-fix-plus fixture: run the same task twice through
# one agent — once baseline, once with --optimize — on an ISOLATED proxy port, then
# compare cost/tokens and print the optimizations that actually fired live.
#
# This exercises three things end-to-end:
#   1. DeepSeek/OpenAI-compatible cost capture (non-zero tokens + cost).
#   2. Live recording of which optimize strategies applied (per session).
#   3. A realistic long read-fix-verify session (~50 requests).
#
# Usage:
#   ./benchmarks/iterative-fix-ab.sh [agent] [--fixture NAME] [--port N] [--keep-serve]
#
#   agent          opencode (default) | claude
#   --fixture      fixture under benchmarks/fixtures/ (default: iterative-fix-plus)
#   --port         proxy port for this run (default: 8199, or $AAP_BENCH_PORT)
#   --keep-serve   leave the optimize proxy running at the end (for manual poking)
#
# Isolation:
#   Runs its OWN `aap serve` on --port so it never touches a proxy you already have
#   on :8080. It uses your configured storage; for FULL isolation (separate DB) set
#   AAP_CONFIG=/path/to/isolated-config.toml before running.
#
# Prereqs: `aap` built + on PATH (npm run build && npm link); the agent installed
#   with its API key; the chosen port free. Run from anywhere.
set -eu

AGENT=opencode
FIXTURE=iterative-fix-plus
PORT="${AAP_BENCH_PORT:-8199}"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fixture) FIXTURE="${2:?--fixture needs a name}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --keep-serve) KEEP=1; shift ;;
    -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

start_serve() { # $1 = extra serve args (e.g. --optimize)
  aap serve $1 >"$LOGDIR/serve-${1:-baseline}.log" 2>&1 &
  SERVE_PID=$!
  i=0
  while [ $i -lt 100 ]; do
    curl -s -m1 "$BASE/health" >/dev/null 2>&1 && return 0
    kill -0 "$SERVE_PID" 2>/dev/null || {
      echo "serve exited early — see $LOGDIR/serve-${1:-baseline}.log" >&2; exit 1; }
    sleep 0.1; i=$((i+1))
  done
  echo "serve did not become healthy on $BASE — see $LOGDIR" >&2; exit 1
}

run_phase() { # $1 = tag, $2 = serve args
  printf '\n\033[1m=== phase: %s (aap serve %s) ===\033[0m\n' "$1" "${2:-<baseline>}"
  start_serve "$2"
  "$HERE/run.sh" "$AGENT" --fixture "$FIXTURE" --tag "$1"
  stop_serve
}

run_phase baseline "--no-optimize"
run_phase optimize "--optimize"

printf '\n\033[1m=== parse + compare ===\033[0m\n'
aap parse >/dev/null 2>&1 || true
aap compare --run baseline --run optimize || true

printf '\n\033[1m=== optimizations recorded (optimize run) ===\033[0m\n'
opt_id=$(aap sessions --json 2>/dev/null | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let rows=[];try{rows=JSON.parse(s)}catch{}
    const hit=rows.find(r=>r.meta&&r.meta.run==="optimize"&&r.meta.task);
    if(hit)process.stdout.write(hit.id);
  });' 2>/dev/null || true)
if [ -n "$opt_id" ]; then
  aap export "$opt_id" | awk '/^## Optimizations applied/{p=1} /^## Recommendations/{p=0} p'
  echo "(full report: aap export $opt_id)"
else
  echo "No optimize session found — check 'aap sessions'."
fi

[ "$KEEP" = "1" ] && echo && echo "optimize proxy still running on $BASE (pid $SERVE_PID)"
exit 0
