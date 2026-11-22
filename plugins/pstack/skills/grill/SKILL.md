---
name: grill
description: "Turn an unclear idea into decisions and checkable outputs before anything is built. Use for a new project, or a large feature whose intent is unclear, while the user is present: 'I have an idea', 'I want to build', 'start a new project', 'help me figure out what to build', 'grill me', 'not sure what I want yet'. Asks only what a person can answer (what to build, for whom, what done looks like, what counts as wrong), each question with a recommended answer and a default, then writes the feature files, glossary, constraints, and the user's rulings. Not for bug fixes, small changes, or requests that are already clear."
---

# Grill

Before a new project or an unclear large feature starts, settle with the user what they want, in their words, and write it down as things a later agent can check. After that, the work runs without asking them again.

## When to run it

- A new project, or a large feature whose intent is unclear, and the user is here to answer. A bug fix, a small change, or a request that is already clear skips this and goes straight to its playbook.
- Nobody is present (an autonomous run, a loop, an overnight program): do not run it. Start from the floor in **constraint-driven-development** and the defaults below, and list the questions you would have asked in the **ketchup** reply, for when the user is back.

## Before the first question

Read what the project already says: its README and instructions file, and any `GLOSSARY.md`, `CONSTRAINTS.md`, `docs/features/`, `docs/adr/`, and `docs/rulings.md`. Facts about the environment (stack, test runner, lint, CI, what already exists) are your job, never the user's: send a subagent with a fresh context to find each one. Tell the user in two lines what you found, then ask only what is left.

## Ask only what a person can answer

Four kinds of question, in plain product language:

- **What** to build, and what is out of scope.
- **For whom**, and what they are trying to get done.
- **Done**: what the user would see that tells them it works.
- **Wrong**: what would make them call it broken, unsafe, or too slow.

Technical choices (data shapes, modules, libraries, where code lives) are not questions for the user. List them under `## Open technical questions` in the feature file they belong to, for **architect**, which runs once grill is done.

## How to ask

This is Matt Pocock's grilling, with Addy Osmani's rule that every question carries a default.

Map the decisions as a **design tree**: every decision branches into the decisions that hang off it. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled, the questions you can ask now without guessing at answers you have not heard yet. Ask the whole frontier in one round: number each question and give your recommended answer and a default. Then wait for the answers before the next round.

```text
❓ **Q1** - **<question title>**: <question body, may list choices>

➡️ <your recommended answer>
🔧 If you don't know: <the default>
```

Word each question so "yes" accepts your recommended answer, and "I don't know" takes the default, so every answer, including not knowing, leaves a working decision. Each round reshapes the tree: settled decisions push the frontier outward. A question whose answer depends on another question still open in this round belongs to a later round.

Do not block on a fact. A running lookup is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest now.

**Quality questions.** When the tree reaches how good is good enough, ask the four questions of **constraint-driven-development** (which checks to enforce, block or warn, numbers or measure-and-hold, the slowest check to tolerate), each with its default, as part of grill's rounds rather than one at a time. Put each in product terms ("should a broken check stop the work, or only warn you?"), and when the user has no view, take the default.

**A question nobody can answer from words.** When the user cannot say how a flow should feel or what a screen should look like until they try it, use **prototype**: a clickable page for logic, or a few very different variants for a screen. The user tries it, then answers. The prototype goes on a throwaway branch; the decision it settled goes into the outputs, with a pointer to that branch.

## What it writes

These files are the project's sources. Later agents read them as the truth. Create each one the first time it has something in it.

| File | What goes in it |
| --- | --- |
| `docs/features/<feature>.md` | One per feature, from the user's point of view: what it is, who it is for, how they reach it, and a **Done when** list. Each item is something a person or a test can judge true or false, written as a checkbox, and ticked only with its proof on the same line (`Proof:` and the test, command, or verification note that showed it); a tick without proof fails the overview check. These are the project's feature entries; a verification skill, if the project gets one, keeps its own map of how to drive each feature, and does not replace them. |
| `GLOSSARY.md` | The project's terms, in the format of **domain-modeling**, written down as each one is settled. When the user's word clashes with a term already there, say so at once. |
| `CONSTRAINTS.md` | The quality bar, in the format of **constraint-driven-development**: every enforced rule names the command that judges it. |
| `docs/adr/NNNN-<slug>.md` | A decision record, only when all three of **domain-modeling**'s conditions hold: hard to reverse, surprising without context, and the result of a real trade-off. |
| `docs/rulings.md` | Each decision the user made: the date, the question, and their answer in their own words. A recommended answer accepted with "yes" is written as accepted. |

A feature file looks like this:

```markdown
# Shared shopping list

Lets two people in one household keep one list and see each other's changes.

For: people who shop for the same home.

How a user gets to it: the Lists tab, then a list's Share button.

## Done when

- [x] A list shared by one person appears for the other within 5 seconds. Proof: `npm test -- share.test.js`
- [ ] Ticking an item off on one phone shows it ticked on the other.
- [ ] Someone who was never invited cannot open the list from its link.
```

`docs/overview.md` is generated from these files by `scripts/overview.mjs` beside this skill (run it with `--write` under the installed plugin): what the project is, how many done conditions are met with proof, what is open, the quality bar, the decisions, and the terms. Never edit it by hand. Any change to a source regenerates it in the same commit, and the merge gate refuses a PR whose overview is stale.

## When it is done

The frontier is empty: every branch of the tree visited, nothing left silently assumed. Read back the decisions in a few lines and ask whether that is it. Only when the user confirms does grill end: write `docs/overview.md` with `scripts/overview.mjs --write`, commit it with the sources, and show the user the overview. Then hand the work to **poteto-mode**: the Feature playbook for one feature, or **figure-it-out** for a new project or a program of work. The user's confirmation stands in for any checkpoint that playbook would otherwise stop at (an irreversible action, such as a deploy or deleting data, still pauses as poteto-mode says), so it builds to these files and does not ask the user again; questions that come up later are decided from the files, the defaults, and the principles.
