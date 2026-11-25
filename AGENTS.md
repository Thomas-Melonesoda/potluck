# potluck: instructions for agents

## What this is
- An open-source agent workflow system: Lauren Tan's pstack at the core, built on Michael Denyer's multi-harness port (pstack-claude), with selected skills from Matt Pocock and Addy Osmani. Users may not be programmers, so every gate must be a check, not a human review.
- Stage: under construction (see the roadmap below). The tree builds on pstack-claude v0.9.146.

## Where progress lives
- [`docs/roadmap.md`](docs/roadmap.md) is the single source of progress. Read it before starting; update it in the PR that finishes a step. Do not keep a second progress copy.

## Layout
- `plugins/pstack/`: the plugin every harness installs. Plugin ID stays `pstack` and skills keep upstream names, to keep syncing cheap.
- `tools/`: `sync.mjs` (upstream sync), `upstream.json` (pins), `forks.json` (every deliberate difference from upstream), `substitutions.json` (Cursor-to-harness rewrites), `generate.mjs` (stamps generated copies), `privacy-check.mjs`.
- `CONTEXT.md` is the glossary; `CONTRIBUTING.md` explains the sync boundary and what fails CI. Read both before changing `tools/` or skill content.

## Setup
- `bun install --frozen-lockfile && bun install --frozen-lockfile --cwd plugins`
- `git config core.hooksPath .githooks` (needs gitleaks on PATH)

## Check before saying done
- `bun tools/generate.mjs --check` and `bun test tests/` must pass.
- Touched sync or skill content: `bun tools/sync.mjs pstack <pinned sha> --dry-run` and `bun tools/sync.mjs --check-rules`; every new difference from upstream gets a `tools/forks.json` entry.
- Touched a workflow: `uvx zizmor@1.29.0 --persona pedantic --min-severity low --collect all -- .`
- Before any push: `node tools/privacy-check.mjs --history` and `gitleaks git . --redact`. This repository is public; no personal paths, names, notes, or secrets.

## Project rules
- New things go in potluck's own new files; edit upstream files only when a decision says so (keeps sync cheap).
- Every difference from upstream is declared in `tools/forks.json` with its reason. Owner rulings appear there only as English paraphrase.
- A new design question (which upstream to follow, a policy change) is not decided by an agent: stop and list it for the owner.
- Commits use this repository's configured identity (a GitHub noreply address). Never commit with a personal or machine-local email.
- Remote `michael` is fetch-only. Never push Michael's tags here.

## AI self-merge (from 2026-11-21, set by the owner)
No levels: apart from "always ask" below, the AI verifies and merges its own PRs; the owner does not review PRs. Trust comes from checks, tests, and the AI's own runtime verification, so none of these conditions may be skipped. Only the owner may waive a step that may not be skipped. The waiver is recorded with the owner's own words and the date. No agent may waive one, the root agent included.
- **Before every merge**:
  1. CI passes on the PR's current head; the local checks above pass.
  2. Behavior a user can trigger changed: run it for real in at least one harness (Claude Code or Codex) and paste the output into the PR.
  3. A bug fix has a regression test that failed first; a new feature's acceptance conditions are tests.
  4. About 400 changed lines or fewer; split larger work.
  5. The PR description says what changed and gives the test evidence.
  6. An agent that did not write the code has verified the current head and recorded its verdict, and the merge goes only through the merge gate (Shipping playbook): `node <installed plugin>/skills/poteto-mode/scripts/merge-gate.mjs merge --repo Thomas-Melonesoda/potluck --pr <pr> --sha <verified sha> --author-email "$(git config user.email)"`. Run the installed plugin's copy, never the copy in the PR's own checkout, so a PR that edits the gate is not judged by its own edit. The gate checks that the PR is open, mergeable, and at the verified head, then the verdict, CI, the quality floor, and the overview, and runs `gh pr merge --squash --match-head-commit` itself. Never run `gh pr merge` directly. Without `--author-email`, GitHub writes the account's primary email into the public merge commit.
- **Always ask the owner first**: releases (editing `VERSION`, tags, GitHub releases); repository settings, visibility, or rulesets; spending money; any change that sends data off the user's machine; editing `AGENTS.md`; a `tools/forks.json` policy entry the owner has not ruled on; changing the `forks.json` or `upstream.json` formats beyond what the roadmap describes; disabling, skipping, or loosening a check (CI jobs, hooks, privacy rules, deleting tests or weakening assertions).
- **Per-task extra permission**: whatever the owner opens up in one task, in their words at the time, holds for that task only.
- **Machine gate**: `main` blocks force pushes and deletion. Do not bypass merge checks (no web-UI merges, no merging through `gh api`).
- **After a bad merge**: write a test that reproduces it, then fix, and add the check that should have caught it. If it loses data or blocks the main flow, open a revert PR first.
