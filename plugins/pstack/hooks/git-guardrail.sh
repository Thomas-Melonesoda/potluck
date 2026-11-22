#!/bin/sh
# potluck: Claude Code's PreToolUse hook for Bash calls. git-guardrail.mjs
# reads the call on stdin and exits 2 to block a git command that would lose
# uncommitted or unpushed work. Without node on PATH the guardrail is off and
# every call runs, as it did before.
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/git-guardrail.mjs"
