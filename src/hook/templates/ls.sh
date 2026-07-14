#!/bin/bash
# aap-hook: ls wrapper — installed to ~/.aap/bin/ls

if [ $# -eq 0 ] || { [ $# -eq 1 ] && [ -d "$1" ]; }; then
  target="${*:-.}"
  echo "$target"
  __REAL_BIN__ "$@" 2>&1 | head -40
else
  __REAL_BIN__ "$@" 2>&1 | head -40
fi
