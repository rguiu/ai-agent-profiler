#!/bin/bash
# aap-hook: git wrapper — installed to ~/.aap/bin/git
# Only filters when hooks are active (wrapper is in PATH).
# If hooks are off, the real git is called directly — this wrapper never runs.

case "$1" in
  status)
    shift
    __REAL_BIN__ status --short --branch "$@" 2>&1 | tail -40
    ;;
  diff)
    shift
    __REAL_BIN__ diff "$@" 2>&1 | tail -80
    ;;
  log)
    shift
    __REAL_BIN__ log --oneline --decorate -15 "$@" 2>&1
    ;;
  show)
    shift
    __REAL_BIN__ show --stat "$@" 2>&1
    ;;
  *)
    exec __REAL_BIN__ "$@"
    ;;
esac
exit ${PIPESTATUS[0]}
