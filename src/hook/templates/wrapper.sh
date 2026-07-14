#!/bin/bash
output=$("__REAL_BIN__" "$@" 2>&1)
rc=$?
echo "$output" | "__NODE_BIN__" "__FILTER_RUNNER__" "__COMMAND__" "$@"
exit $rc
