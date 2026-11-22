// potluck: eval layers 1 and 2 (D8) in tools/eval.mjs. The checks run on
// small made-up skill lists here, and once on the real tree.
import { describe, expect, test } from "bun:test";

import { index, layer1, layer2, main, stem, tokens } from "../tools/eval.mjs";

const skill = (dir, description, extra = {}) => ({ dir, name: dir, description, userInvocable: true, ...extra });
const SKILLS = [
  skill("review", "Review a pull request diff for bugs before it merges"),
  skill("deploy", "Deploy the service to production and watch the rollout"),
  skill("explain", "Explain how a piece of code works, step by step"),
];

describe("tokens", () => {
  test("stems plurals and verb forms, and keeps how and why", () => {
    expect(stem("reviewing")).toBe("review");
    expect(stem("tests")).toBe("test");
    expect(stem("dependencies")).toBe("dependency");
    expect(tokens("How does the parser work? Why?")).toEqual(["how", "parser", "work", "why"]);
  });
});

describe("layer 1", () => {
  const cases = SKILLS.map((s) => ({ prompt: s.dir, skill: s.dir }));
  test("a clean list passes", () => {
    expect(layer1(SKILLS, cases, { titles: ["Bug fix"], files: ["bug-fix"] })).toEqual([]);
  });
  test("names each structural problem", () => {
    const bad = [skill("Bad_Name", ""), skill("long", "x".repeat(1025)), { ...skill("moved", "y"), name: "old" }];
    const problems = layer1(bad, [{ prompt: "p", skill: "ghost" }, { prompt: "q" }, { prompt: "r", not: ["long"], known: "why" }], { titles: ["Bug fix", "Feature"], files: ["bug-fix", "orphan"] });
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
      'evals/triggers.json: case "r" has a "known" mark without a positive skill and a reason',
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
  test("a negative fails only when the skill ranks first with a real score", () => {
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "deploy to production", not: ["deploy"] }] }).problems[0]).toContain("ranks deploy first");
    expect(layer2(SKILLS, { ...base, cases: [{ prompt: "rename a variable", not: ["review", "deploy", "explain"] }] }).problems).toEqual([]);
  });
  test("the rank-1 share has a floor", () => {
    const r = layer2(SKILLS, { ...base, topK: 3, minRank1: 100, cases: [{ prompt: "review this pull request", skill: "review" }, { prompt: "watch it", skill: "explain" }] });
    expect(r.rate).toBe(50);
    expect(r.problems).toEqual(["trigger: 50% of positive cases rank their skill first, under the floor of 100%"]);
  });
  test("two descriptions alike collide unless the pair is allowed with a reason", () => {
    const twins = [skill("ship", "Deploy the service to production and watch the rollout"), SKILLS[1]];
    expect(layer2(twins, { ...base, collision: 0.5, cases: [] }).problems[0]).toContain("collision: ship and deploy");
    expect(layer2(twins, { ...base, collision: 0.5, cases: [], allowCollisions: [{ pair: ["ship", "deploy"], why: "w" }] }).problems).toEqual([]);
    expect(index(twins).pairs()[0].score).toBeGreaterThan(0.5);
    expect(layer2(twins, { ...base, collision: 0.5, cases: [], allowCollisions: [{ pair: ["ship", "deploy"] }] }).problems[0]).toContain("needs two existing skills and a reason");
  });
});

test("the real tree passes both layers", () => {
  expect(main([])).toBe(0);
  expect(main(["--layer", "3"])).toBe(2);
});
