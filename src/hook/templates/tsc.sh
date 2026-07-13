#!/bin/bash
# aap-hook: tsc wrapper — installed to ~/.aap/bin/tsc
# Filters TypeScript compiler output to errors only

HOOK_MODE="normal"
REAL_TSC="__REAL_BIN__"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec "$REAL_TSC" "$@"; }

output=$("$REAL_TSC" "$@" 2>&1)
rc=$?

if [ "$rc" -eq 0 ]; then
  echo "ok tsc"
  exit 0
fi

if [ "$HOOK_MODE" = "aggressive" ]; then
  echo "$output" | grep -E "^[^(].*error TS" | head -20
  echo "$output" | grep "Found.*error" | tail -1
else
  echo "$output" | grep -E "^(error|.*error TS|Found.*error)"
fi

exit $rc
