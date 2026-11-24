#!/bin/sh
# potluck: Claude Code's PreToolUse hook for Edit, Write, MultiEdit, and
# NotebookEdit. operator-gates.mjs exits 2 to block a call that would change a
# gates file, which only the user changes. Without node on PATH every call runs.
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/operator-gates.mjs"
