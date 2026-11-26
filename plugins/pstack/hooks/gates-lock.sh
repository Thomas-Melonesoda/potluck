#!/bin/sh
# potluck: Claude Code's PreToolUse hook for Edit, Write, MultiEdit, and
# NotebookEdit. operator-gates.mjs exits 2 to block a call that would change a
# gates file, which only the user changes. If node itself fails (any exit but
# 0 or 2) on a call whose input names gates.json or .potluck, the call is
# blocked too. Without node on PATH every call runs.
command -v node >/dev/null 2>&1 || exit 0
input=$(cat)
printf '%s' "$input" | node "$(dirname "$0")/operator-gates.mjs"
status=$?
case $status in 0 | 2) exit $status ;; esac
case $input in
  *gates.json* | *.potluck*)
    echo "potluck: the gates lock failed (exit $status) on a call that names gates.json or .potluck, so it is blocked." >&2
    exit 2 ;;
esac
exit $status
