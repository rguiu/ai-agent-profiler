#!/bin/bash
# aap-hook: cargo wrapper — installed to ~/.aap/bin/cargo

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
    exit $rc
    ;;
  *)
    exec __REAL_BIN__ "$@"
    ;;
esac
