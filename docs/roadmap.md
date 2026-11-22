# potluck roadmap

This is the single source of progress for potluck. Agents read it before starting work and update it in the same PR that finishes a step. The owner's original wording for each decision is kept privately; [`tools/forks.json`](../tools/forks.json) carries the English paraphrase.

Status values: **done**, **in progress**, **not started**.

## Stage 0: preparation (done, 2026-11-21)

- Forked from pstack-claude `97d2ba2` (v0.9.146), which pins Lauren Tan's pstack at `0b46ec3`.
- All four upstreams are MIT: Lauren Tan (2026), Michael Denyer (2026), Matt Pocock (2026), Addy Osmani (2025); cursor-team-kit and thermos are Cursor (2026).
- `bun tools/sync.mjs pstack 0b46ec3 --dry-run` and `--check-rules` pass locally.

## Stage 1: rename and pre-push checks (done, 2026-11-21)

- Public names changed to potluck; plugin ID stays `pstack`; README is bilingual.
- LICENSE and NOTICE keep upstream copyright lines and add potluck's.
- gitleaks and [`tools/privacy-check.mjs`](../tools/privacy-check.mjs) run in the pre-commit hook and in CI over the full history.
- Repository published; `main` blocks force pushes and deletion; private vulnerability reporting is on.

## Stage 2: sync tooling and the decision register (done, 2026-11-21)

- `bun tools/sync.mjs revert <component> <path>` restores one file to its upstream version with substitutions and generator stamps, and drops its `forks.json` entry ([#5](https://github.com/Thomas-Melonesoda/potluck/pull/5)).
- `tools/upstream.json`: a component may set its own `remote` ([#4](https://github.com/Thomas-Melonesoda/potluck/pull/4)).
- `tools/forks.json` entries carry `source`, `choice`, `row`, `ruling`, `decided`, and `kind` gains `borrow` ([#6](https://github.com/Thomas-Melonesoda/potluck/pull/6)). pstack-claude's own `upstream` (proposal status) and `since` keep their meaning, so potluck's "which upstream" field is `source`. Every entry is filled from the step 3 review, and a test requires the whole register on each entry.
- [`docs/decisions.md`](decisions.md) is generated from `forks.json` by `node tools/decisions.mjs`; a test fails when it is stale.

## Stage 3: align with pstack where pstack-claude differs (not started)

- Merging and autopilot: the lead agent merges on a clean verdict without waiting for a human; a deterministic merge gate (verdict commit status, CI, quality floor, `--match-head-commit`); two fix rounds per PR, then the root agent decides.
- Evidence, parallel worktrees, session pickup, foreground routing, review and cleanup: follow pstack-claude, with automatic backups before worktree cleanup.
- Bring in pstack's usage guide, bilingual; leave `automations/` out for now; no telemetry.

## Stage 4: borrow from Matt Pocock and Addy Osmani (not started)

- New `grill` skill for new projects or unclear large features; prototype and wizard skills; glossary and decision-record formats.
- `CONSTRAINTS.md` and an always-on quality floor run inside the merge gate.
- Three eval layers: structure, trigger collisions (in CI), behavior (after upstream syncs).
- A narrow git guardrail hook that blocks commands which would lose uncommitted or unpushed work.
- A generated, read-only project overview alongside pstack's existing reports.

## Stage 5: owner's personal layer (not started, private)

Personal configuration stays outside this repository.
