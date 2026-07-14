#!/bin/bash
# aap-hook: npm wrapper — installed to ~/.aap/bin/npm

REAL_NPM="__REAL_BIN__"

is_filtered=0
case "$1" in
  test) is_filtered=1 ;;
  run)
    case "$2" in
      test|build|lint|typecheck) is_filtered=1 ;;
    esac
    ;;
esac

if [ "$is_filtered" = "0" ]; then
  exec "$REAL_NPM" "$@"
fi

output=$("$REAL_NPM" "$@" 2>&1)
rc=$?

if [ "$rc" -eq 0 ]; then
  echo "ok npm $*"
  exit 0
fi

echo "$output" | grep -E -i "(error|fail|FAIL|ERROR|✗|✘|×)" | tail -20
echo "---"
echo "$output" | tail -10
exit $rc
