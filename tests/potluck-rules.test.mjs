// potluck: each rule the owner ruled on in the step 3 and step 4 reviews is pinned to the
// sentence that carries it, so an edit or an upstream merge that drops one
// fails here. Rows refer to docs/decisions.md.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skills = join(import.meta.dir, "../plugins/pstack/skills");

const RULES = [
  { row: "A1", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "The operator's go starts the program; after it, no merge waits for a person." },
  { row: "A3", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "Before the first owner starts, tell the operator the size of the program" },
  { row: "A6", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "Choose one, without waiting for the operator: a fresh owner that tries a different approach, splitting the PR into smaller ones, or parking it as a draft with the decision written in the trail." },
  { row: "A8", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "never with `gh pr merge` or `--auto` directly" },
  { row: "A8", file: "poteto-mode/playbooks/shipping.md", phrase: "Never run `gh pr merge` yourself." },
  { row: "A8", file: "poteto-mode/playbooks/shipping.md", phrase: "Never arm `--auto`" },
  { row: "A11", file: "poteto-help/SKILL.md", phrase: "runs [Autopilot-stack](../poteto-mode/playbooks/autopilot-stack.md), which stacks the PRs and merges nothing." },
  { row: "C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "For every worktree in the confirmed set, clean ones included, run `node` on `skills/poteto-mode/scripts/worktree-backup.mjs`" },
  { row: "C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "Only a recorded `backed-up` or `nothing-to-back-up` result clears a worktree for step 5, and the agent then deletes it without asking." },
  { row: "C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "Never push a `backup/` branch" },
  { row: "G1", file: "poteto-mode/SKILL.md", phrase: "A new project, or a large feature whose intent is unclear, with the user present → **grill** first, and build to the files it writes." },
  { row: "G1", file: "grill/SKILL.md", phrase: "A bug fix, a small change, or a request that is already clear skips this and goes straight to its playbook." },
  { row: "G2", file: "grill/SKILL.md", phrase: "send a subagent with a fresh context to find each one. Tell the user in two lines what you found, then ask only what is left." },
  { row: "G4", file: "grill/SKILL.md", phrase: "Map the decisions as a **design tree**" },
  { row: "G4", file: "grill/SKILL.md", phrase: "Ask the whole frontier in one round" },
  { row: "G5", file: "grill/SKILL.md", phrase: "| `GLOSSARY.md` | The project's terms, in the format of **domain-modeling**" },
  { row: "G5", file: "grill/SKILL.md", phrase: "only when all three of **domain-modeling**'s conditions hold" },
  { row: "G6", file: "grill/SKILL.md", phrase: "The prototype goes on a throwaway branch; the decision it settled goes into the outputs" },
  { row: "G7", file: "grill/SKILL.md", phrase: "so it builds to these files and does not ask the user again" },
  { row: "G8", file: "poteto-mode/SKILL.md", phrase: "With nobody present, skip it: start from the floor in **constraint-driven-development** and the defaults" },
  { row: "G3", file: "grill/SKILL.md", phrase: "Technical choices (data shapes, modules, libraries, where code lives) are not questions for the user." },
  { row: "G4", file: "grill/SKILL.md", phrase: "Word each question so \"yes\" accepts your recommended answer, and \"I don't know\" takes the default" },
  { row: "G5", file: "grill/SKILL.md", phrase: "| `docs/rulings.md` | Each decision the user made: the date, the question, and their answer in their own words." },
  { row: "G7", file: "grill/SKILL.md", phrase: "Only when the user confirms does grill end: write `docs/overview.md`" },
  { row: "G8", file: "grill/SKILL.md", phrase: "Nobody is present (an autonomous run, a loop, an overnight program): do not run it." },
  { row: "R2", file: "grill/SKILL.md", phrase: "Never edit it by hand. Any change to a source regenerates it in the same commit, and the merge gate refuses a PR whose overview is stale." },
  { row: "R5", file: "poteto-mode/SKILL.md", phrase: "A change to the states a feature moves through (a flow, a status, a protocol) → run **statechart** on it and put the new diagram in your reply, unasked." },
  { row: "R1", file: "grill/SKILL.md", phrase: "| `docs/features/<feature>.md` | One per feature, from the user's point of view" },
  { row: "C4", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "A rebase that stops on a conflict, or a push the lease refuses, goes to the root" },
];

describe("potluck's ruled rules", () => {
  test.each(RULES.map((r) => [r.row, r.file, r.phrase]))("%s holds in %s", (_, file, phrase) => {
    const text = readFileSync(join(skills, file), "utf8").replace(/\s+/g, " ");
    expect(text).toContain(phrase);
  });
});
