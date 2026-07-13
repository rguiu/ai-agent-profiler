#!/bin/bash
# aap-hook: node wrapper — installed to ~/.aap/bin/node
# Reads ~/.aap/hook-mode for filtering level (off|normal|aggressive)

HOOK_MODE="normal"
REAL_NODE="__REAL_BIN__"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')

is_test=0
for arg in "$@"; do
  case "$arg" in --test|--test=*) is_test=1; break ;; esac
done

if [ "$is_test" = "0" ] || [ "$HOOK_MODE" = "off" ]; then
  exec "$REAL_NODE" "$@"
fi

output=$("$REAL_NODE" "$@" 2>&1)
rc=$?

if [ "$HOOK_MODE" = "aggressive" ]; then
  # Aggressive: failures + summary, strip YAML diagnostic blocks
  echo "$output" | awk '
    BEGIN { skip=0 }
    /^ *---/ { skip=1; next }
    /^ *\.\.\./ { skip=0; next }
    skip { next }
    /^ *not ok/ { print; next }
    /^ *# fail [0-9]/ { print; next }
    /^[0-9]+\.\.[0-9]+/ { counts=$0; next }
    END { if (counts) print counts }
  '
else
  # Normal: skip passing individual tests, keep failure details (including diagnostics)
  echo "$output" | awk '
    BEGIN { skip=0; tests=0; fail=0 }
    /^ *ok [0-9]/ { tests++; next }
    /^ *not ok [0-9]/ { tests++; fail++; print; skip=0; next }
    /^ *# fail/ { print; next }
    /^ *# pass/ { next }
    /^ *# tests/ { next }
    /^ *# suites/ { next }
    /^ *# duration/ { next }
    /^ *# cancelled/ { next }
    /^ *# skipped/ { next }
    /^ *# todo/ { next }
    /^TAP version/ { next }
    /^[0-9]+\.\.[0-9]+/ { next }
    /^(ok|not ok) [0-9]/ { print; next }
    /^$/ { next }
    { print }
    END {
      printf "  %d/%d passed", tests-fail, tests
      if (fail > 0) printf ", %d failed", fail
      printf "\n"
    }
  '
fi

exit $rc
