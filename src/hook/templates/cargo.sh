#!/bin/bash
# aap-hook: cargo wrapper — installed to ~/.aap/bin/cargo
# Reads ~/.aap/hook-mode for filtering level (off|normal|aggressive)

HOOK_MODE="normal"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec __REAL_BIN__ "$@"; }

case "$1" in
  test)
    __REAL_BIN__ test "$@" 2>&1 | \
      grep -E "^(test |running |failures|error\[|   -->)" | head -60
    rc=${PIPESTATUS[0]}
    exit $rc
    ;;
  build|check|clippy)
    __REAL_BIN__ "$@" 2>&1 | \
      grep -E "^(error|warning)\[" | head -30
    rc=${PIPESTATUS[0]}
    [ "$HOOK_MODE" = "aggressive" ] && exit $rc
    exit $rc
    ;;
  *)
    exec __REAL_BIN__ "$@"
    ;;
esac
