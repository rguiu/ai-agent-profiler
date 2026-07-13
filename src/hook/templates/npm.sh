#!/bin/bash
# aap-hook: npm wrapper — installed to ~/.aap/bin/npm
HOOK_MODE="normal"
REAL_NPM="__REAL_BIN__"
[ -r "$HOME/.aap/hook-mode" ] && HOOK_MODE=$(cat "$HOME/.aap/hook-mode" 2>/dev/null | tr -d '\n')

is_filtered=0
case "$1" in
  test) is_filtered=1 ;;
  run)
    case "$2" in
      test|build|lint|typecheck) is_filtered=1 ;;
    esac
    ;;
esac

if [ "$is_filtered" = "0" ] || [ "$HOOK_MODE" = "off" ]; then
  exec "$REAL_NPM" "$@"
fi

output=$("$REAL_NPM" "$@" 2>&1)
rc=$?

if [ "$rc" -eq 0 ]; then
  echo "ok npm $*"
  exit 0
fi

echo "$output" | grep -E -i "(error|fail|FAIL|ERROR|✗|✘|×)" | head -20
echo "$output" | tail -2
exit $rc
