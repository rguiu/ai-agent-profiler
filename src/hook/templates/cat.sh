#!/bin/bash
# aap-hook: cat wrapper — installed to ~/.aap/bin/cat

__REAL_BIN__ "$@" 2>/dev/null | head -60
