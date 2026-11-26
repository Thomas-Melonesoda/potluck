# The operator's gates

potluck's defaults follow Lauren Tan's pstack: a passing verdict from an agent that did not write the code authorizes a merge, and green CI alone never does. Some operators want stricter settings than that, such as having a person merge every PR that no CI tested. The gates file holds those settings. It can only make potluck stricter, never looser.

## Where it lives

| File | Applies to |
|---|---|
| `~/.potluck/gates.json` | every repository you work in |
| `.potluck/gates.json` at a repository's root | that repository, for everyone who works in it |

Both files apply. For each gate the stricter value wins, so a repository's file cannot loosen yours, and yours cannot loosen the repository's. poteto-mode reads them with `gates.mjs` when a run starts, from the checkout it runs in. Nothing reads the repository's file at a PR's base, so a PR can loosen the repository's file it is merged under; see [known gaps](#known-gaps).

## What it holds

```json
{
  "noCI": "wait",
  "foreignRepos": "ask",
  "askFirst": ["publishing a release", "spending money"]
}
```

| Key | Values (default first) | What the stricter value does |
|---|---|---|
| `noCI` | `"merge"`, `"wait"` | A PR with no CI result stops at merge-ready, and a person merges it. |
| `foreignRepos` | `"allow"`, `"ask"` | A `gh` command that writes to a repository that neither the `gh` account nor one of its organizations owns needs the user's yes first: a comment, review, issue, or pull request, an edit or state change to one, or a write through `gh api`. |
| `askFirst` | a list of actions | The agent asks the user before each one. Items from both files apply. |
| `trustRepos` | a list of owners or `owner/name` repositories | The `foreignRepos` check treats these as your own, beside the `gh` account and its organizations. Read only from your own `~/.potluck/gates.json`, so a repository's file cannot widen it. |

Every key is optional. An unknown key or value, or a key given twice, is an error, so a typo such as `"noCi"` fails loudly instead of dropping a gate. JSON has no comments, so keep notes about the file somewhere else.

A repository's file that cannot be parsed makes `gates.mjs` exit 1 with the error instead of printing the gates, so a run in that checkout starts without them. Fix such a file by hand.

## Who reads it

- **poteto-mode, when a run starts.** It runs `gates.mjs` and follows each line it prints. The Shipping and Autopilot-full playbooks then hold a PR with no CI result at merge-ready for a person when `noCI` is `"wait"`. This is a written rule the agent follows, not a script that refuses.
- **A hook before each shell command, on Claude Code and Codex.** With `foreignRepos` set to `"ask"`, `hooks/operator-gates.mjs`, which the Bash hook `hooks/git-guardrail.sh` runs after the git guardrail, reads each Bash call. It does not try to work out where a `gh` write goes. A call runs without a prompt only when its text, as the hook reads it, shows a read or a plain write to a repository you own, and every other `gh` call it sees gets Claude Code's permission prompt with the reason. It runs only if the user approves. Two kinds pass:

  - **A read.** `gh pr` view, list, status, diff, checks, or checkout; `gh issue` view, list, or status; `gh repo` view, list, or clone; `gh run` and `gh workflow` view and list, `gh run watch`, `gh release` view and list, `gh search`, `gh auth status`, `gh status`, and `--help` (not `-h`, which `gh repo edit` reads as `--homepage` and `gh auth login` as `--hostname`). `gh api` counts as a read only with no method other than `GET` or `HEAD`, no `-f`, `-F`, `--field`, `--raw-field`, or `--input` in any spelling (`-if` included), and an endpoint that is not GraphQL. A list of reads, not of writes: a subcommand it does not know asks.
  - **One plain write to a repository you own.** The whole command is a single `gh` call with every word literal: no `&&`, `;`, pipe, redirect, `$`, backtick, glob, `VAR=` prefix, or wrapper such as `sh -c`, `eval`, `nice`, or `xargs`. It is a `gh pr` comment, review, create, edit, close, reopen, ready, merge, revert, update-branch, lock, or unlock, a `gh issue` comment, create, edit, close, reopen, lock, unlock, pin, unpin, or delete, or a `gh api` call on a `repos/<owner>/<name>/...` path on github.com. It names its repository with `--repo owner/name` (`-R owner/name`, `-Rowner/name`, `--repo=owner/name`) or with a `github.com` URL right after the subcommand, and the `gh` account or one of its organizations owns every repository and URL among its words.

  For example, `gh pr comment 44 --repo you/app --body done` passes, and these ask:

  - `gh pr comment 44 --body done`, which leaves `gh` to pick the repository from the checkout. That is the price of the rule: the hook does not predict that choice, so name the repository to skip the prompt.
  - anything chained or wrapped, such as `git remote add upstream <url> && gh pr create --fill`, `GIT_DIR=... gh ...`, or `sh -c '...'`, even when every `gh` call in it writes to your own repository;
  - a write the shell fills in or expands, such as `-R "$R"`, `$(cat pr.txt)`, `$GH`, or `/opt/homebrew/bin/g[h]`;
  - `gh api` on GraphQL, on a full URL, or on any path other than `repos/<owner>/<name>/...`, such as `repositories/<id>/...`;
  - `--repo` inside a run of short flags (`-sR`) or right after a flag that may take it as its value (`-b --repo me/app`), and a link to someone else's repository anywhere among the words;
  - a write this check cannot place, such as `gh issue transfer`, `gh release create`, or `gh repo set-default`, and a call whose account cannot be read, or any `gh` call that may write while a gates file cannot be parsed.

  The hook reads the command line, so it stops an agent's shortcut, not a deliberate evasion. A script file that runs `gh`, a heredoc or pipe fed to `sh`, a `$(gh ...)` inside an unquoted heredoc body (the shell runs it, but the hook skips heredoc bodies), brace expansion that spells `gh`, `gh alias`, and a `gh` call sent through another language are out of its reach. It reads the gates file of the directory the command starts in. Codex runs the same hook once you trust it through `/hooks`, but rejects an "ask" decision, so there a call that would ask is blocked with its reason, and you run it yourself. Other harnesses have no such hook yet, so there poteto-mode asks before running a write to a repository the account does not own. A repository on your `trustRepos` list counts as yours.
- **poteto-mode, when a run starts.** It runs `node <plugin>/skills/poteto-mode/scripts/gates.mjs` in the repository and follows each line it prints, `askFirst` items included. Run it yourself to see the gates in force:

  ```text
  $ node <plugin>/skills/poteto-mode/scripts/gates.mjs
  The operator's gates, stricter than potluck's defaults:
  - noCI: wait (/home/you/.potluck/gates.json). A PR with no CI result ...
  - Ask the user first: publishing a release
  ```

## No checks is not a failed check

The agent merges only a head whose checks all finished green. A PR has "no checks" only when no workflow runs on it, no check is required, and none reported: the repository has no CI, or its CI runs only on pushes to `main`. potluck's default merges such a PR on its verdict, and `noCI: "wait"` holds it for a person instead. A PR whose CI has not started yet, or whose head asks GitHub to skip CI (`[skip ci]` and the like), is not a PR with no checks, so the agent waits for its CI or pushes a head without the skip.

Until 2026-11-25 the merge gate script listed the checks a PR should get, from its workflows' triggers and the base branch's required checks, and refused while one had not reported. That script is retired, so telling "CI has not started" from "no CI" is now the agent's reading of the PR's checks; see [known gaps](#known-gaps).

## Only the user changes a gates file

An agent never changes a gates file, the root agent included: the gates are the operator's own, so an agent follows them and may suggest a change, such as a repository to add to `trustRepos`, and the user makes it. potluck's hooks block an agent's change, with or without a gates file:

- on Claude Code, and on Codex once you trust the hook, every shell command that names `gates.json` or `.potluck` as a whole path part (`aggregates.json`, `gates.json.example`, and `.potluck.yml` pass), or the full path of the file `~/.potluck/gates.json` links to. Reads are blocked too, because telling a read from a write kept missing a spelling. So the agent reads a gates file with its file-reading tool, and cannot `cat`, `grep`, `git add`, or `git commit` one by name in the shell, or mention one in a commit message or an inline `--body` (use `--body-file` with a file of another name). You run those yourself. One exemption: a literal, unquoted path in potluck's own folders, `~/.potluck/decisions`, `~/.potluck/trash`, or `~/.potluck/backup` (written with `~/`, `$HOME/`, or your full home path), in a line whose every command is `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `du`, or `grep`, or appends to the decision log with `log.sh`. A `cd`, a copy or move, an output redirect (other than `2>/dev/null` or `2>&1`), a backslash (so a line split with `\`), `..`, a glob, a second `.potluck` in one path, or `gates.json` in the line still blocks, so you move a worktree back from the trash yourself. A backslash before `.potluck` always counts as a Windows path, so a search or `sed` script that escapes it (`grep 'www\.potluck'`) is blocked, and so is `.\potluck`, which reads as `.potluck`. What it does not catch is listed below;
- on Claude Code, an Edit, Write, MultiEdit, or NotebookEdit call on one. Codex edits files through its own patch tool, which this hook does not read yet.

The lock stops an agent's shortcut, not someone set on getting around it. These are out of its reach and stay open:

- a name built when the command runs: from a loop variable (`$d.potluck`), by a default value (`${1:-.potluck}`, `${1-.potluck}`, and the same with `gates.json`), from braces (`.{x,potluck}`), or from a hex or octal escape (`$'\x2epotluck'`);
- some `find` patterns (`find -name '*.potluck'`) and most other globs (`.pot*`);
- either name glued to a short option whose dash does not follow a space, a quote, or the start of a line, such as one after `=`, `(`, `{`, or `,`: `o=-xzC.potluck; tar $o -f ../a.tgz`, `opts=(-xzC.potluck -f ../a.tgz); tar "${opts[@]}"`, `o=-d.potluck; unzip -qo ../a.zip $o`, and `tar {-xzC.potluck,-f../a.tgz}` pass and can replace a gates file;
- `gates.json` right after three or more option letters (`-fsSLogates.json`), and either name right after options that hold a digit (`-p1d.potluck`);
- another letter case in a shell command (`.Potluck`), which is the same folder on macOS and Windows;
- on Windows, an option glued to the name (`rd/s/q.potluck`), a caret inside it (`.pot^luck`), a short name (`POTLUC~1`), and `%~dp0.potluck`;
- in a shell command, the Windows folder followed by a backslash and a letter, with no backslash before it: `dir .potluck\decisions`, `del .potluck\gates.*`, and `Remove-Item .potluck\gates*` pass, and the last two would delete the gates file (`.potluck\gates.json` in full blocks; checked by feeding the hook these lines on macOS, not on Windows);
- in an edit tool, the file your `~/.potluck/gates.json` links to spelled in another letter case (`GATES.JSON`), which is the same file on a disk that ignores case;
- in an edit tool, the file a repository's own `.potluck/gates.json` links to;
- a hard link to a gates file, in the shell or an edit tool;
- an edit that would create a gates file through a link of another name, or a Write to the missing file your `~/.potluck/gates.json` links to;
- in the shell, a link target whose own name does not contain `gates.json`, unless the call reaches the hook for another reason;
- a script file, and a command that names nothing, such as `git add -A`, `git stash -u`, or one run from inside the folder.

The record of a change is the file's git history: your personal repository for your own file, the project's repository for its file. No separate register is kept.

## Known gaps

The two lists of what is out of reach, for the [shell hook](#who-reads-it) and for the [gates lock](#only-the-user-changes-a-gates-file), are above. These gaps are in merging:

- **A verdict is not signed by its verifier.** `potluck/verdict` is a commit status, and nothing checks who wrote it. The same holds for the root agent's `potluck-cosign` comment, which the floor job reads: it counts only a whole-line marker in a comment by the repository's owner, a member, or a collaborator, but cannot tell the root agent from another agent on the same account. The agents on one machine usually share one `gh` token, so an agent that wrote a change can, in principle, also write its passing verdict or its co-sign. A GitHub ruleset that requires the status cannot tell the two apart either. Closing it needs a GitHub identity that only the verifier uses. The owner decided (2026-11-24) to leave that until potluck has other users or this happens.
- **CI that has not started can look like no CI** (since 2026-11-25). The retired merge gate script listed the checks a PR should get and refused while one had not reported, or after ten minutes as CI that did not start. Now the agent reads the PR's checks itself, so a PR read before its CI started, or whose workflows wait for a maintainer's approval, could pass for one with no checks. On potluck's own `main` the ruleset requires `potluck/verdict` but no CI check, so GitHub does not catch it either.
- **A PR can loosen the repository's gates file it is merged under** (since 2026-11-25). The retired merge gate script read the file at the PR's base as well as its head and kept the stricter value. Now only `gates.mjs` reads it, at the start of a run and from the checkout, so a PR that edits or deletes the repository's file is judged by its own edit. The user's own `~/.potluck/gates.json` is not in a PR and is not affected.
- **The floor runs only where CI runs it.** potluck's own CI runs the floor and the overview check on every pull request. In another repository, the playbooks have the agent run `floor.mjs` before merging, and a project made with grill's starter also runs the floor in its pre-commit hook, but no service refuses the merge there.

Three guards were built and failed their last review round, so they are parked as draft PRs and not in potluck. The owner decided (2026-11-25) to list them here and stop for now. The first is no longer wanted: since 2026-11-25 agents merge with `gh pr merge --match-head-commit` themselves, as the Shipping playbook says. Until one of the other two lands, a direct push to a default branch and a merge while a gates file has uncommitted changes are stopped only by the operator's own tools, if any.

- **Direct merges are the design now** ([#62](https://github.com/Thomas-Melonesoda/potluck/pull/62)). #62 blocked `gh pr merge` so that agents would merge only through the merge gate script. With that script retired, #62 is not needed.
- **A push straight to a default branch is not blocked** ([#53](https://github.com/Thomas-Melonesoda/potluck/pull/53)). The git guardrail still blocks force pushes and pushes that lose work, but an ordinary `git push` from `main` passes. The hook in #53 blocked it, but it let one force push through that the guardrail blocks today (a URL given with `--repo`, on a repository whose default branch is not `main` or `master`), and it blocked ordinary lines, such as restoring a file with `git checkout --theirs README.md` and pushing in the same command, or pushing a tag whose name is computed, such as `git push origin "v$V"`. On potluck's own repository, the ruleset on `main` has a pull request rule, so GitHub refuses every direct push to `main` there; other repositories have only their own settings.
- **Nothing refuses a merge while a gates file has uncommitted changes** ([#61](https://github.com/Thomas-Melonesoda/potluck/pull/61)). This check was meant to cover the Codex patch tool, which the gates lock does not read, so on Codex an agent can still change a gates file without the user seeing it before a merge. The check in #61 still let a merge through when the link to the user's gates file went through a deleted folder followed by `..`, or when the name differed in a way the file system folds and `toLowerCase` does not, such as `ß` and `ss`.
