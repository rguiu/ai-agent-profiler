#!/bin/bash
# aap-hook: ls wrapper — installed to ~/.aap__REAL_BIN__
HOOK_MODE="normal"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec __REAL_BIN__ "$@"; }

if [ "$HOOK_MODE" = "aggressive" ]; then
  __REAL_BIN__ "$@" 2>&1 | head -30
elif [ $# -eq 0 ] || { [ $# -eq 1 ] && [ -d "$1" ]; }; then
  target="${*:-.}"
  echo "$target"
  __REAL_BIN__ "$@" 2>&1 | head -40
else
  __REAL_BIN__ "$@" 2>&1 | head -40
fi
