#!/bin/sh
# Evaluate optimization effectiveness by running a task twice (baseline vs optimized)
# and comparing the sessions. Uses the dry-run simulator for instant results on
# existing sessions, or runs the full benchmark for live comparison.
#
# Usage:
#   ./benchmarks/optimize-eval.sh <session-id>           # dry-run on existing session
#   ./benchmarks/optimize-eval.sh --live <agent> [opts]  # full A/B run (baseline + optimized)
#
# Dry-run mode (recommended for hypothesis verification):
#   Takes an existing captured session and reports what --optimize would have saved.
#   No agent re-run needed. Instant feedback.
#
# Live mode (for validating that optimization doesn't regress task success):
#   Runs the same task twice — once through normal proxy, once with --optimize.
#   Compares results and checks both pass verification.
#
# Prereqs: `aap serve` running; `aap` built and on PATH.
set -eu

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then usage; exit 0; fi
if [ $# -eq 0 ]; then usage; exit 1; fi

if [ "$1" = "--live" ]; then
  echo "Live A/B mode not yet implemented."
  echo "Use dry-run mode: ./benchmarks/optimize-eval.sh <session-id>"
  echo ""
  echo "Live mode will be added once --optimize is wired into aap serve."
  exit 1
fi

# Dry-run mode
SESSION="$1"
shift

echo "=== Optimization Dry-Run ==="
echo ""
aap optimize "$SESSION" "$@"
echo ""
echo "To compare with a real optimized run later:"
echo "  1. Start proxy with: aap serve --optimize=dedup,truncate"
echo "  2. Re-run the same task"
echo "  3. Compare: aap compare <baseline-session> <optimized-session>"
