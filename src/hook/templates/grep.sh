#!/bin/bash
# aap-hook: grep/rg wrapper — installed to ~/.aap/bin/grep and ~/.aap/bin/rg

__REAL_BIN__ "$@" 2>/dev/null | tail -40
