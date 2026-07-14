#!/bin/bash
# aap-hook: find wrapper — installed to ~/.aap/bin/find

__REAL_BIN__ "$@" 2>/dev/null | head -60
