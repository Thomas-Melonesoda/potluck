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

Every key is optional. An unknown key or value, or a key given twice, is an error, so a typo such as `"noCi"` fails loudly instead of dropping a gate. JSON has no comments, so keep notes about the file somewhere else.

A repository's file that cannot be parsed refuses every merge, including the PR that would fix it, because the merge gate reads the file at the PR's base as well as its head. Fix such a file on the default branch by hand, or have a person merge the fix.

## Who reads it

- **The merge gate.** `merge-gate.mjs merge` reads both files after every other check passes. With `noCI` set to `"wait"`, a PR with no CI result comes back `{"kind": "held", ...}` with exit 1 and is not merged. A gates file that cannot be parsed refuses the merge.
- **A hook before each shell command, on Claude Code.** With `foreignRepos` set to `"ask"`, `hooks/operator-gates.mjs`, which the Bash hook `hooks/git-guardrail.sh` runs after the git guardrail, reads each Bash call, inside `sh -c`, `eval`, and subshells too. A `gh` write aimed at a repository that the `gh` account does not own, and that none of its organizations owns, gets Claude Code's permission prompt with the reason, and runs only if the user approves. The writes are:

  - `gh pr`: comment, review, create, edit, close, reopen, ready, merge, revert, update-branch, lock, and unlock;
  - `gh issue`: comment, create, edit, close, reopen, lock, unlock, pin, unpin, transfer, delete, and develop;
  - `gh api` calls that write to a `repos/<owner>/<repo>` path.

  Rather than predict which repository `gh` picks, the check asks when any repository the write could reach is not owned:

  - each `github.com` URL among the arguments, a link in a comment's body included;
  - each `--repo` value, in any of `gh`'s spellings (`-R <repo>`, `-R<repo>`, `-sR <repo>`, `--repo=<repo>`);
  - without `--repo`, each `GH_REPO` value, and the repository `gh` resolves in each directory the command starts in or changes to, a `cd` inside a subshell, brace group, or `sh -c` included.

  This can ask more often than needed, for example for a comment on your own pull request that links someone else's. It also asks when it cannot read where a write goes:

  - a repository, selector, endpoint, or GraphQL query the shell fills in at run time, such as `"$R"` or `$(cat pr.txt)`, or a directory it cannot follow (`cd "$DIR"`, `cd -`);
  - a GraphQL mutation, which names no repository;
  - a write when the account cannot be read, or when a gates file cannot be parsed.

  Your own repositories pass without a prompt. Other harnesses have no such hook yet, so there poteto-mode asks before running these commands.
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

## Loosening a gate

Removing a gate, setting a looser value, or adding to a skip or allow list loosens a check. An agent never does that alone: it needs the root agent's countersign, as in Autopilot-full step 6, and a register entry. The person a file belongs to can change it at any time.
