// potluck: eval layers 1 and 2 (S4-D8) in tools/eval.mjs. The checks run on
// small made-up skill lists here, and once on the real tree.
import { describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frontmatter, index, layer1, layer2, main, readPlaybooks, stem, tokens } from "../tools/eval.mjs";

const skill = (dir, description, extra = {}) => ({ dir, name: dir, description, userInvocable: true, ...extra });
const SKILLS = [
  skill("review", "Review a pull request diff for bugs before it merges"),
  skill("deploy", "Deploy the service to production and watch the rollout"),
  skill("explain", "Explain how a piece of code works, step by step"),
];

describe("tokens", () => {
  test("puts a word family on one stem, and keeps how and why", () => {
    expect(new Set(["change", "changes", "changed", "changing"].map(stem))).toEqual(new Set(["chang"]));
    expect(new Set(["file", "files"].map(stem)).size).toBe(1);
    expect(new Set(["pass", "passes"].map(stem)).size).toBe(1);
    expect(stem("apply")).toBe("apply");
    expect(stem("verified")).toBe(stem("verify"));
    expect(stem("dependencies")).toBe("dependency");
    expect(tokens("How does the parser work? Why? Don't.")).toEqual(["how", "parser", "work", "why"]);
  });
});

describe("frontmatter", () => {
  test("reads plain, quoted, and block descriptions", () => {
    expect(frontmatter('---\nname: a\ndescription: "Say \\"hi\\""\n---\n').description).toBe('Say "hi"');
    expect(frontmatter("---\nname: a\ndescription: 'it''s'\n---\n").description).toBe("it's");
    expect(frontmatter("---\nname: a\ndescription: >\n  one\n  two\nuser-invocable: false\n---\n")).toEqual({ name: "a", description: "one two", userInvocable: false });
  });
});

describe("layer 1", () => {
  const cases = SKILLS.map((s) => ({ prompt: s.dir, skill: s.dir }));
  test("a clean list passes", () => {
    expect(layer1(SKILLS, cases, { titles: ["Bug fix"], files: ["bug-fix"] })).toEqual([]);
  });
  test("names each structural problem", () => {
    const bad = [skill("Bad_Name", ""), skill("long", "x".repeat(1025)), { ...skill("moved", "y"), name: "old" }];
    const problems = layer1(bad, [{ prompt: "p", skill: "ghost" }, { prompt: "q" }, { prompt: "r", not: ["long"], known: " " }], { titles: ["Bug fix", "Feature"], files: ["bug-fix", "orphan"] });
    expect(problems).toEqual([
      "skills/Bad_Name: name must be lowercase words joined by hyphens, at most 64 characters",
      "skills/Bad_Name: no description",
      "skills/long: description is 1025 characters, over 1024",
      'skills/moved: frontmatter name is "old", not the folder name',
      "skills/Bad_Name: no trigger case in evals/triggers.json",
      "skills/long: no trigger case in evals/triggers.json",
      "skills/moved: no trigger case in evals/triggers.json",
      'evals/triggers.json: case "p" names ghost, which is not a skill',
      'evals/triggers.json: case "q" has neither "skill" nor "not"',
      'evals/triggers.json: case "r" has a "known" mark without a reason',
      "poteto-mode/playbooks/orphan.md: not in poteto-mode's playbook list",
      "poteto-mode's playbook list names feature, which has no playbooks/feature.md",
    ]);
  });
  test("a skill the user cannot invoke needs no trigger case", () => {
    expect(layer1([skill("principle-x", "p", { userInvocable: false })], [], null)).toEqual([]);
  });
});

describe("layer 2", () => {
  const base = { topK: 1, minScore: 0.1, collision: 0.9 };
  test("a positive in the top k passes and one outside fails", () => {
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "review this pull request", skill: "review" }] }).problems).toEqual([]);
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "review this pull request", skill: "deploy" }] }).problems[0]).toContain("ranks deploy at");
  });
  test("a known miss is reported, not failed, and fails once it passes", () => {
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "review this pull request", skill: "deploy", known: "gap" }] }).problems).toEqual([]);
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "review this pull request", skill: "review", known: "gap" }] }).problems[0]).toContain('remove its "known" mark');
  });
  test("a positive whose skill shares no word with the prompt has not fired, even at rank 1", () => {
    const r = layer2(SKILLS.slice(0, 1), { ...base, cases: [{ prompt: "zzz", skill: "review" }] });
    expect(r.report[0].rank).toBe(Infinity);
    expect(r.problems[0]).toContain("outside the top 1");
  });
  test("a prompt that matches only the skill's name has not fired", () => {
    const skills = [skill("deploy", "x"), skill("review", "Review a pull request diff for bugs")];
    const r = layer2(skills, { ...base, cases: [{ prompt: "deploy it", skill: "deploy" }] });
    expect(r.report[0].rank).toBe(Infinity);
  });
  test("a known false positive is reported, not failed, and fails once it stops firing", () => {
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "deploy to production", not: ["deploy"], known: "gap" }] }).problems).toEqual([]);
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "rename a variable", not: ["deploy"], known: "gap" }] }).problems[0]).toContain("no longer fires deploy");
  });
  test("a negative fails only when the skill ranks first with a real score", () => {
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "deploy to production", not: ["deploy"] }] }).problems[0]).toContain("ranks deploy first");
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "rename a variable", not: ["review", "deploy", "explain"] }] }).problems).toEqual([]);
  });
  test("the rank-1 share has a floor", () => {
    const r = layer2(SKILLS, { ...base, topK: 3, minRank1: 100, cases: [{ prompt: "review this pull request", skill: "review" }, { prompt: "watch the deploy rollout and explain it", skill: "explain" }] });
    expect(r.rate).toBe(50);
    expect(r.problems).toEqual(["trigger: 50% of positive cases rank their skill first, under the floor of 100%"]);
  });
  test("two descriptions alike collide unless the pair is allowed with a reason", () => {
    const twins = [skill("ship", "Deploy the service to production and watch the rollout"), SKILLS[1]];
    expect(layer2(twins, { ...base, collision: 0.5, cases: [] }).problems[0]).toContain("collision: ship and deploy");
    expect(layer2(twins, { ...base, collision: 0.5, cases: [], allowCollisions: [{ pair: ["ship", "deploy"], why: "w" }] }).problems).toEqual([]);
    expect(index(twins).pairs()[0].score).toBeGreaterThan(0.5);
    expect(layer2(twins, { ...base, collision: 0.5, cases: [], allowCollisions: [{ pair: ["ship", "deploy"] }] }).problems[0]).toContain("needs two existing skills and a reason");
    expect(layer2(twins, { ...base, collision: 0.5, cases: [], allowCollisions: [{ why: "w" }] }).problems[0]).toContain("needs two existing skills and a reason");
    expect(layer2(SKILLS, { ...base, collision: 0.5, cases: [], allowCollisions: [{ pair: ["review", "deploy"], why: "w" }] }).problems[0]).toContain("remove the pair from allowCollisions");
  });
});

describe("the playbook list", () => {
  const roots = [];
  const tree = (skill) => {
    const root = mkdtempSync(join(tmpdir(), "potluck-eval-"));
    roots.push(root);
    const mode = join(root, "plugins/pstack/skills/poteto-mode");
    mkdirSync(join(mode, "playbooks"), { recursive: true });
    writeFileSync(join(mode, "SKILL.md"), skill);
    for (const f of ["bug-fix", "feature", "eval", "babysit", "shipping", "refactoring"]) writeFileSync(join(mode, "playbooks", `${f}.md`), "");
    return root;
  };
  test("reads the titles from the Playbooks section", () => {
    const root = tree("## Playbooks\n\nMatch the task.\n\nBug fix, Feature, Eval, Babysit, Shipping, Refactoring.\n");
    expect(readPlaybooks(root).titles).toEqual(["Bug fix", "Feature", "Eval", "Babysit", "Shipping", "Refactoring"]);
    expect(layer1([], [], readPlaybooks(root))).toEqual([]);
  });
  test("a missing list fails for every playbook file instead of passing", () => {
    const root = tree("## Playbooks\n\nMatch the task.\n");
    expect(layer1([], [], readPlaybooks(root)).filter((p) => p.includes("not in poteto-mode's playbook list"))).toHaveLength(6);
    roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  });
});

test("the real tree passes, and a failing check exits 1", () => {
  expect(main([])).toBe(0);
  expect(main(["--layer", "1"])).toBe(0);
  expect(main(["--layer", "2", "--report"])).toBe(0);
  expect(main(["--layer", "3"])).toBe(2);
  const root = mkdtempSync(join(tmpdir(), "potluck-eval-main-"));
  mkdirSync(join(root, "plugins/pstack/skills/poteto-mode/playbooks"), { recursive: true });
  mkdirSync(join(root, "evals"));
  writeFileSync(join(root, "plugins/pstack/skills/poteto-mode/SKILL.md"), "---\nname: poteto-mode\ndescription: Route work\n---\n## Playbooks\n");
  writeFileSync(join(root, "evals/triggers.json"), JSON.stringify({ cases: [] }));
  expect(main(["--layer", "1"], root)).toBe(1);
  rmSync(root, { recursive: true, force: true });
});

describe("layer 3 case structure", () => {
  test("a case needs a prompt with text and graders of a known type, naming a real skill", async () => {
    const { evalCaseProblems } = await import("../tools/eval.mjs");
    const root = mkdtempSync(join(tmpdir(), "potluck-eval-l3-"));
    const at = (...p) => join(root, "plugins/pstack/evals", ...p);
    mkdirSync(at("good", "graders"), { recursive: true });
    writeFileSync(at("good", "prompt.md"), "---\nname: good\n---\n\nDo the thing.\n");
    writeFileSync(at("good", "graders", "fired.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '\"skill\"\\s*:\\s*\"(?:[\\w-]+:)?grill\"'\nmin: 1\n---\n");
    mkdirSync(at("bad", "graders"), { recursive: true });
    writeFileSync(at("bad", "prompt.md"), "---\nname: other\n---\n");
    writeFileSync(at("bad", "graders", "x.md"), "---\ntype: vibes\n---\n");
    writeFileSync(at("bad", "graders", "y.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '\"skill\"\\s*:\\s*\"(?:[\\w-]+:)?ghost\"'\n---\n");
    mkdirSync(at("empty"), { recursive: true });
    mkdirSync(at("forms", "graders"), { recursive: true });
    writeFileSync(at("forms", "prompt.md"), '---\nname: "forms" # quoted, with a comment\nmaxturns: 3\n---\n\nGo.\n');
    writeFileSync(at("forms", "graders", "a.md"), '---\ntype: "llm"\n---\n');
    writeFileSync(at("forms", "graders", "b.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '\"skill\"\\s*:\\s*\"pstack:grilll\"'\nwith_only: true\n---\n");
    writeFileSync(at("forms", "graders", "c.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: 'grill'\n---\n");
    mkdirSync(at("mocks"), { recursive: true });
    mkdirSync(at("more", "graders"), { recursive: true });
    writeFileSync(at("more", "prompt.md"), "---\nname: more\ndescription: valid key\nschema_version: \"1.0\"\nplugins: [pstack]\nexpected_outcome: done\nartifact_publish: false\ngrowthbook_overrides: {}\n---\n\nGo.\n");
    writeFileSync(at("more", "graders", "c.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '\"skill\"\\s*:\\s*\"(?:[a-z]+:)?grill\"'\n---\n");
    writeFileSync(at("more", "graders", "d.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '(?i)grill'\n---\n");
    writeFileSync(at("more", "graders", "e.md"), '---\ntype: tool_used\ntool: Skill\ninput_match: "\\\\bgrill\\\\b"\n---\n');
    writeFileSync(at("more", "graders", "a.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '\\bgrill\\b'\n---\n");
    writeFileSync(at("more", "graders", "b.md"), "---\ntype: tool_used\ntool: Skill\ninput_match: '\"skill\"\\s*:\\s*\"(?:grilll|grill)\"'\n---\n");
    expect(evalCaseProblems(root, new Set(["grill"])).sort()).toEqual([
      "plugins/pstack/evals/bad/graders/x.md: type must be one of regex, tool_used, tool_order, file_exists, llm, baseline",
      "plugins/pstack/evals/bad/graders/y.md: expects skill ghost, which is not a skill",
      "plugins/pstack/evals/bad/prompt.md: name is other, not the folder name",
      "plugins/pstack/evals/bad/prompt.md: no prompt text",
      "plugins/pstack/evals/empty: no prompt.md",
      "plugins/pstack/evals/forms/graders/a.md: an llm grader needs its criteria in the body",
      "plugins/pstack/evals/forms/graders/b.md: expects skill grilll, which is not a skill",
      "plugins/pstack/evals/forms/graders/b.md: with_only is not a grader key; use arm: with-only or arm: both",
      "plugins/pstack/evals/forms/prompt.md: unknown frontmatter key maxturns",
      "plugins/pstack/evals/more/graders/b.md: expects skill grilll, which is not a skill",
    ]);
    expect(evalCaseProblems(root, new Set(["grill"])).some((p) => p.includes("/good"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
