#!/bin/sh
# potluck: Claude Code's PreToolUse hook for Bash calls. git-guardrail.mjs
# reads the call on stdin and exits 2 to block a git command that would lose
# uncommitted or unpushed work. A call it lets through goes on to
# operator-gates.mjs, which prints an "ask" decision when the operator's gates
# set foreignRepos to "ask" and the call runs gh in a way not proven to be a
# read or a write to the user's own repository. That check starts node only
# for a call that names gh or holds a quote, backslash, $, backtick, or glob
# character ([, *, ?), the ways a command can spell gh without writing it out.
# A call that names gates.json or .potluck goes to it as well, which blocks it. Codex's hooks file passes `codex`, which turns an ask into a
# block, since Codex rejects "ask". Without node on PATH both are off and
# every call runs, as it did before. If either check fails (any exit but 0 or
# 2) on a call that names gates.json or .potluck, the call is blocked, so the
# gates lock fails closed; any other failed check lets the call run.
command -v node >/dev/null 2>&1 || exit 0
input=$(cat)
here=$(dirname "$0")
settle() {
  case $1 in 0) return 0 ;; 2) exit 2 ;; esac
  case $input in
    *gates.json* | *.potluck*)
      echo "potluck: a check failed (exit $1) on a call that names gates.json or .potluck, so it is blocked." >&2
      exit 2 ;;
  esac
  exit "$1"
}
printf '%s' "$input" | node "$here/git-guardrail.mjs"
settle $?
case $input in
  *gh* | *gates.json* | *.potluck* | *\'* | *\\* | *'$'* | *'`'* | *'['* | *'*'* | *'?'*)
    printf '%s' "$input" | node "$here/operator-gates.mjs" "$@"
    settle $? ;;
esac
