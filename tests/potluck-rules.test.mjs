// potluck: each rule the owner ruled on in the step 3 and step 4 reviews is pinned to the
// sentence that carries it, so an edit or an upstream merge that drops one
// fails here. Rows refer to docs/decisions.md.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const skills = join(import.meta.dir, "../plugins/pstack/skills");

const RULES = [
  { row: "S3-A1", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "The operator's go starts the program; after it, no merge waits for a person." },
  { row: "S3-A3", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "Before the first owner starts, tell the operator the size of the program" },
  { row: "S3-A6", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "Choose one, without waiting for the operator: a fresh owner that tries a different approach, splitting the PR into smaller ones, or parking it as a draft with the decision written in the trail." },
  { row: "S3-A6", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "Before each fix-forward the owner runs `node` on `skills/poteto-mode/scripts/fix-rounds.mjs`" },
  { row: "S3-A8", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "--squash --match-head-commit <verified-head> --author-email \"$(git config user.email)\"`, never with `--auto`." },
  { row: "S3-A8", file: "poteto-mode/playbooks/shipping.md", phrase: "with `gh pr merge <pr> --repo <owner/repo> --squash --match-head-commit <verified-head> --author-email \"$(git config user.email)\"`" },
  { row: "S3-A8", file: "poteto-mode/playbooks/shipping.md", phrase: "Never arm `--auto`" },
  { row: "S3-A8", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "ending with the line `potluck-cosign: <head sha> <fingerprint>`, and rerun the failed floor job. A new head needs a new co-sign." },
  { row: "S3-A11", file: "poteto-help/SKILL.md", phrase: "runs [Autopilot-stack](../poteto-mode/playbooks/autopilot-stack.md), which stacks the PRs and merges nothing." },
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "For every worktree in the confirmed set, clean ones included, run `node` on `skills/poteto-mode/scripts/worktree-remove.mjs`" },
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "It runs `worktree-backup.mjs` first" },
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "A recorded `removed` result is the agent's deletion, made without asking." },
  // Stage 5 issue 6: the three safeguards on top of S3-C3.
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "Then it checks the backup: each backup branch exists at the commit the backup made, and the tarball holds the same files, at the same sizes, as the worktree on disk." },
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "Never `git worktree remove --force` or `rm -rf` a worktree, what is left of one, or a trash folder" },
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "It refuses any other path (the main checkout, a folder inside a worktree, anything outside every worktree)." },
  { row: "S3-C3", file: "poteto-mode/playbooks/worktree-cleanup.md", phrase: "Never push a `backup/` branch" },
  { row: "S4-G1", file: "poteto-mode/SKILL.md", phrase: "A new project, or a large feature whose intent is unclear, with the user present → **grill** first, and build to the files it writes." },
  { row: "S4-G1", file: "grill/SKILL.md", phrase: "A bug fix, a small change, or a request that is already clear skips this and goes straight to its playbook." },
  { row: "S4-G2", file: "grill/SKILL.md", phrase: "send a subagent with a fresh context to find each one. Tell the user in two lines what you found, then ask only what is left." },
  { row: "S4-G4", file: "grill/SKILL.md", phrase: "Map the decisions as a **design tree**" },
  { row: "S4-G4", file: "grill/SKILL.md", phrase: "Ask the whole frontier in one round" },
  { row: "S4-G5", file: "grill/SKILL.md", phrase: "| `GLOSSARY.md` | The project's terms, in the format of **domain-modeling**" },
  { row: "S4-G5", file: "grill/SKILL.md", phrase: "only when all three of **domain-modeling**'s conditions hold" },
  { row: "S4-G6", file: "grill/SKILL.md", phrase: "The prototype goes on a throwaway branch; the decision it settled goes into the outputs" },
  { row: "S4-G7", file: "grill/SKILL.md", phrase: "so it builds to these files and does not ask the user again" },
  { row: "S4-G8", file: "poteto-mode/SKILL.md", phrase: "With nobody present, skip it: start from the floor in **constraint-driven-development** and the defaults" },
  { row: "S4-G1", file: "poteto-mode/SKILL.md", phrase: "writing or editing a `GLOSSARY.md`, or recording an ADR → **domain-modeling**. No quality bar written down, a request to set one, a threshold to pick, or a check silenced or a test skipped to get to green → **constraint-driven-development**." },
  { row: "S4-G1", file: "poteto-mode/SKILL.md", phrase: "A bug fix, a small change, or a request that is already clear skips **grill**." },
  { row: "S4-R6", file: "grill/SKILL.md", phrase: "First of all, where this version ends: something to show, something they use themselves, something others try, or something public." },
  { row: "S4-R6", file: "grill/SKILL.md", phrase: "When the project has one of these, the tree grows a branch for it" },
  { row: "S4-R6", file: "grill/SKILL.md", phrase: "| Automatic messages, scheduled jobs, or calls with side effects | Repeats, retries, when to stop, who may approve |" },
  { row: "S4-G3", file: "grill/SKILL.md", phrase: "Technical choices (data shapes, modules, libraries, where code lives) are not questions for the user." },
  { row: "S4-G4", file: "grill/SKILL.md", phrase: "Word each question so \"yes\" accepts your recommended answer, and \"I don't know\" takes the default" },
  { row: "S4-G5", file: "grill/SKILL.md", phrase: "| `docs/rulings.md` | Each decision the user made: the date, the question, and their answer in their own words." },
  { row: "S4-G7", file: "grill/SKILL.md", phrase: "Only when the user confirms does grill end: write `docs/overview.md`" },
  { row: "S4-G8", file: "grill/SKILL.md", phrase: "Nobody is present (an autonomous run, a loop, an overnight program): do not run it." },
  { row: "S4-R2", file: "grill/SKILL.md", phrase: "Never edit it by hand. Any change to a source regenerates it in the same commit, and the quality floor check refuses a PR whose overview is stale." },
  { row: "S4-R2", file: "poteto-mode/SKILL.md", phrase: "A change that meets an item in a `docs/features/` Done when list → tick it in the same commit, with `Proof:`" },
  { row: "S4-R5", file: "poteto-mode/SKILL.md", phrase: "A change to the states a feature moves through (a flow, a status, a protocol) → run **statechart** on it and put the new diagram in your reply, unasked." },
  { row: "S4-R1", file: "grill/SKILL.md", phrase: "| `docs/features/<feature>.md` | One per feature, from the user's point of view" },
  { row: "S3-C4", file: "poteto-mode/playbooks/autopilot-full.md", phrase: "A rebase that stops on a conflict, or a push the lease refuses, goes to the root" },
  { row: "S3-D2", file: "poteto-mode/playbooks/pause-safely.md", phrase: "the task's folder, inside Git or not, plus a task name when another task may checkpoint in the same folder." },
  { row: "S3-D3", file: "poteto-mode/playbooks/session-pickup.md", phrase: "If it reports missing, list the store and read the checkpoint whose folder and task match the request." },
  { row: "S3-D3", file: "poteto-mode/playbooks/session-pickup.md", phrase: "Compare the recorded head first. When it moved, the branch changed after the pause (new commits, a reset, or a deleted branch), so recheck the note's claims against that change, as step 4 does, before you rely on it." },
  { row: "S3-D2", file: "poteto-mode/playbooks/pause-safely.md", phrase: "is not a pause, so \"keep going\" still holds. Skip step 1 and keep any subagents running." },
  { row: "S3-D2", file: "poteto-mode/SKILL.md", phrase: "its checkpoint-and-keep-going mode serves a request to save progress or write a handoff that does not ask you to stop (存一下进度, 交接)" },
  { row: "S3-D3", file: "poteto-mode/SKILL.md", phrase: "Session pickup serves a request to resume earlier work (接着上次做, 接手, or 接着做 at the start of a session)." },
];

describe("potluck's ruled rules", () => {
  test.each(RULES.map((r) => [r.row, r.file, r.phrase]))("%s holds in %s", (_, file, phrase) => {
    const text = readFileSync(join(skills, file), "utf8").replace(/\s+/g, " ");
    expect(text).toContain(phrase);
  });
});

describe("handoff requests load poteto-mode from every session-start mandate", () => {
  const hooks = join(import.meta.dir, "../plugins/pstack/hooks");
  const mandates = readdirSync(hooks).filter((f) => f.endsWith(".md") && readFileSync(join(hooks, f), "utf8").includes("when a task meets any of these"));
  test("finds the mandates", () => expect(mandates.length).toBeGreaterThan(0));
  test.each(mandates)("S3-D2, S3-D3 hold in hooks/%s", (file) => {
    expect(readFileSync(join(hooks, file), "utf8")).toContain("- it asks to pause, hand off, save progress, or pick up earlier work, in any language (暂停一下, 交接, 存一下进度, 接着做)");
  });
});

test("docs/reference.md lists as many routing conditions as the session-start mandate", () => {
  const root = join(import.meta.dir, "..");
  const mandate = readFileSync(join(root, "plugins/pstack/hooks/session-start-context.md"), "utf8");
  const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
  const conditions = mandate.match(/^- it /gm).length;
  const listed = reference.split("when a task meets any of these conditions:\n\n")[1].split("\n\n")[0].match(/^- /gm).length;
  expect(listed).toBe(conditions);
});
