#!/bin/bash
# aap-hook: node wrapper — installed to ~/.aap/bin/node

REAL_NODE="__REAL_BIN__"

is_test=0
for arg in "$@"; do
  case "$arg" in --test|--test=*) is_test=1; break ;; esac
done

if [ "$is_test" = "0" ]; then
  exec "$REAL_NODE" "$@"
fi

output=$("$REAL_NODE" "$@" 2>&1)
rc=$?

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

exit $rc
