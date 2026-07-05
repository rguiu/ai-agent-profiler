#!/bin/sh
# Run the benchmark task suite through one agent, each run tagged via `aap run --meta`.
#
#   ./benchmarks/run.sh opencode
#   ./benchmarks/run.sh claude
#
# Prereqs:
#   - `aap serve` running in another terminal
#   - the agent installed and its API key configured (opencode auth / ANTHROPIC/DEEPSEEK key)
#   - `aap` on PATH (npm link)
#
# Each task runs against a fresh copy of benchmarks/fixture in a scratch dir,
# so edits never touch the repo and every run starts from the same state.
set -eu

AGENT="${1:?usage: run.sh <opencode|claude>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HERE/fixture"
SCRATCH="${AAP_BENCH_SCRATCH:-/tmp/aap-bench}"

case "$AGENT" in
  opencode) INVOKE="run" ;;   # opencode run "<prompt>"
  claude)   INVOKE="-p"  ;;   # claude -p "<prompt>"
  *) echo "unknown agent: $AGENT (use opencode or claude)"; exit 1 ;;
esac

run_task() {
  id="$1"; prompt="$2"
  rm -rf "$SCRATCH"
  cp -r "$FIXTURE" "$SCRATCH"
  echo ">>> task=$id agent=$AGENT"
  ( cd "$SCRATCH" && aap run --meta "task=$id" --meta "agent=$AGENT" "$AGENT" "$INVOKE" "$prompt" ) || true
}

run_task explain \
  "Explain what this project does and how src/parser.js works. Do not change any files."

run_task locate \
  "Where is parseLine defined and where is it used? List files and line numbers. Do not change any files."

run_task fix-bug \
  "The test suite (npm test) has a failing test. Find and fix the bug in the source so all tests pass."

run_task add-feature \
  "Add a boolean 'trim' option to parse(options) that strips leading/trailing whitespace from each cell. Add a test for it and make sure npm test passes."

echo
echo "All tasks run. Next:"
echo "  aap parse"
echo "  aap compare --task fix-bug        # once you've run another agent too"
