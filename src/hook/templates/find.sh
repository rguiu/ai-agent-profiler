#!/bin/bash
# aap-hook: find wrapper — installed to ~/.aap/bin/find
HOOK_MODE="normal"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec __REAL_BIN__ "$@"; }

if [ "$HOOK_MODE" = "aggressive" ]; then
  __REAL_BIN__ "$@" 2>/dev/null | head -30
else
  __REAL_BIN__ "$@" 2>/dev/null | head -60
fi
