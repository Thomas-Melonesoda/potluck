# The operator's gates

potluck's defaults follow Lauren Tan's pstack: a passing verdict from an agent that did not write the code authorizes a merge, and green CI alone never does. Some operators want stricter settings than that, such as having a person merge every PR that no CI tested. The gates file holds those settings. It can only make potluck stricter, never looser.

## Where it lives

| File | Applies to |
|---|---|
| `~/.potluck/gates.json` | every repository you work in |
| `.potluck/gates.json` at a repository's root | that repository, for everyone who works in it |

Both files apply. For each gate the stricter value wins, so a repository's file cannot loosen yours, and yours cannot loosen the repository's. The merge gate reads the repository's file at the PR's base and at its head, so a PR cannot delete or weaken the gate it is judged by.

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
| `noCI` | `"merge"`, `"wait"` | A PR with no CI result stops at merge-ready. The merge gate reports it `held`, and a person merges it. |
| `foreignRepos` | `"allow"`, `"ask"` | A `gh` command that writes to a repository that neither the `gh` account nor one of its organizations owns needs the user's yes first: a comment, review, issue, or pull request, an edit or state change to one, or a write through `gh api`. |
| `askFirst` | a list of actions | The agent asks the user before each one. Items from both files apply. |
| `trustRepos` | a list of owners or `owner/name` repositories | The `foreignRepos` check treats these as your own, beside the `gh` account and its organizations. Read only from your own `~/.potluck/gates.json`, so a repository's file cannot widen it. |

Every key is optional. An unknown key or value, or a key given twice, is an error, so a typo such as `"noCi"` fails loudly instead of dropping a gate. JSON has no comments, so keep notes about the file somewhere else.

A repository's file that cannot be parsed refuses every merge, including the PR that would fix it, because the merge gate reads the file at the PR's base as well as its head. Fix such a file on the default branch by hand, or have a person merge the fix.

## Who reads it

- **The merge gate.** `merge-gate.mjs merge` reads both files after every other check passes. With `noCI` set to `"wait"`, a PR with no CI result comes back `{"kind": "held", ...}` with exit 1 and is not merged. A gates file that cannot be parsed refuses the merge.
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

The merge gate refuses a PR whose checks failed or are still running. A PR with no CI result at all has "no checks": the repository has no CI, or its CI does not run on pull requests, as when it runs only on pushes to `main`. potluck's default merges such a PR on its verdict, and `noCI: "wait"` holds it instead. A result with no checks says so with `checks: "none"`.

Silence counts as no checks only when nothing says CI is still coming. The gate refuses while a GitHub Actions check suite on the head is unfinished, or waits for a maintainer's approval, as on a fork PR. In a repository with workflows it also refuses when the head commit's message asks GitHub to skip CI (`[skip ci]` and the like), and when GitHub has held the head for less than a minute, judged by its oldest commit status, since CI may not have started yet. A PR with no checks that changes `.github/workflows/` is held for a person under any setting, since its silence may be its own doing.

## Only the user changes a gates file

An agent never changes a gates file, the root agent included: the gates are the operator's own, so an agent follows them and may suggest a change, such as a repository to add to `trustRepos`, and the user makes it. potluck's hooks block an agent's change, with or without a gates file:

- on Claude Code and Codex, a shell command that may change `~/.potluck/gates.json` (or the file it links to) or a `.potluck/gates.json`: an output redirect into it, `rm`, `cp`, `sed -i`, a script, a `git checkout` of the file, removing, moving, or copying over its `.potluck` folder, or any of these on a bare `gates.json` after a `cd`. Reading one or its folder (`ls`, `find`, `cp -r` out of it), a redirect of a read's output somewhere else (`2>/dev/null`, `> /tmp/view.json`), and `git add`, `commit`, `diff`, `log`, or `show` of your own edit, pass;
- on Claude Code, an Edit, Write, MultiEdit, or NotebookEdit call on one. Codex edits files through its own patch tool, which this hook does not read yet.

The record of a change is the file's git history: your personal repository for your own file, the project's repository for its file. No separate register is kept.
