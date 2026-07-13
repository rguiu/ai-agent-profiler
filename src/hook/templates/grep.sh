#!/bin/bash
# aap-hook: grep/rg wrapper — installed to ~/.aap/bin/grep and ~/.aap/bin/rg
HOOK_MODE="normal"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')
[ "$HOOK_MODE" = "off" ] && { exec __REAL_BIN__ "$@"; }

if [ "$HOOK_MODE" = "aggressive" ]; then
  __REAL_BIN__ "$@" 2>/dev/null | head -20
else
  __REAL_BIN__ "$@" 2>/dev/null | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head -15
fi
