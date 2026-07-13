#!/bin/bash
# aap-hook: git wrapper — installed to ~/.aap/bin/git
# Reads ~/.aap/hook-mode for filtering level (off|normal|aggressive)

HOOK_MODE="normal"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec __REAL_BIN__ "$@"; }

case "$1" in
  status)
    __REAL_BIN__ status --short --branch 2>&1 | head -40
    ;;
  diff)
    if [ "$HOOK_MODE" = "aggressive" ]; then
      __REAL_BIN__ diff --stat "$@" 2>&1
    else
      __REAL_BIN__ diff "$@" 2>&1 | head -80
    fi
    ;;
  log)
    __REAL_BIN__ log --oneline --decorate -15 "$@" 2>&1
    ;;
  show)
    __REAL_BIN__ show --stat "$@" 2>&1
    ;;
  *)
    exec __REAL_BIN__ "$@"
    ;;
esac
exit ${PIPESTATUS[0]}
