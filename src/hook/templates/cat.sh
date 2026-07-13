#!/bin/bash
# aap-hook: cat wrapper — installed to ~/.aap/bin/cat
HOOK_MODE="normal"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec __REAL_BIN__ "$@"; }

if [ "$HOOK_MODE" = "aggressive" ]; then
  __REAL_BIN__ "$@" 2>/dev/null | head -60
else
  exec __REAL_BIN__ "$@"
fi
