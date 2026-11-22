// potluck: each rule the owner ruled on in the step 3 review is pinned to the
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
  { row: "C4", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "A rebase that stops on a conflict, or a push the lease refuses, goes to the root" },
];

describe("potluck's ruled rules", () => {
  test.each(RULES.map((r) => [r.row, r.file, r.phrase]))("%s holds in %s", (_, file, phrase) => {
    const text = readFileSync(join(skills, file), "utf8").replace(/\s+/g, " ");
    expect(text).toContain(phrase);
  });
});
