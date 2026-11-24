#!/bin/sh
# potluck: Claude Code's PreToolUse hook for Bash calls. git-guardrail.mjs
# reads the call on stdin and exits 2 to block a git command that would lose
# uncommitted or unpushed work. A call it lets through goes on to
# operator-gates.mjs, which prints an "ask" decision when the operator's gates
# set foreignRepos to "ask" and the call runs gh in a way not proven to be a
# read or a write to the user's own repository. That check starts node only
# for a call that names gh or holds a quote, backslash, $, backtick, or glob
# character ([, *, ?), the ways a command can spell gh without writing it out.
# A call that names a gates file goes to it as well, which blocks an agent's
# change to one. Codex's hooks file passes `codex`, which turns an ask into a
# block, since Codex rejects "ask". Without node on PATH both are off and
# every call runs, as it did before.
command -v node >/dev/null 2>&1 || exit 0
input=$(cat)
here=$(dirname "$0")
printf '%s' "$input" | node "$here/git-guardrail.mjs" || exit $?
case $input in
  *gh* | *gates.json* | *.potluck* | *\'* | *\\* | *'$'* | *'`'* | *'['* | *'*'* | *'?'*) printf '%s' "$input" | node "$here/operator-gates.mjs" "$@" ;;
esac
