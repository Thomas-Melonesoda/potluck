# PROJECT_NAME

Instructions for agents in this repository. One line per item, with real commands and paths, at most 60 lines. Write "to confirm" in a section nobody knows yet.

## What this is

- What it does, for whom, and where this version ends, in one line.
- Stage: just started.

## Where progress lives

- Each feature's Done when list is in `docs/features/`, and `docs/overview.md` is generated from those files. Read them before starting. Tick an item only with its proof.
- The terms are in `GLOSSARY.md`, the quality bar in `CONSTRAINTS.md`, and the owner's decisions in `docs/rulings.md`.

## Layout

- To confirm: each important folder or file, and what lives there.

## Run it

- Set up: to confirm.
- Run: to confirm.

## Check before saying done

- One command runs every check (types, lint, tests, build): CHECK_COMMAND. CI runs it on every pull request and on main.
- The pre-commit hook runs the quality floor and a secret scan. A check that fails is fixed, never loosened or skipped.
- A bug fix starts with a test that fails.

## Project rules

- To confirm: naming, formatting, and anything else this project does its own way.

## Do not touch

- To confirm: files or folders an agent must not edit, and why.
- Ask before deleting data, publishing, or pushing to a shared branch.
