// potluck: the git guardrail blocks an agent's direct merge (stage 5 follow-up
// issue 1, design row S3-A8). Each line is read, and none is run.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { directMerge } from "../plugins/pstack/hooks/direct-merge.mjs";

const root = join(import.meta.dir, "..");
const wrapper = join(root, "plugins/pstack/hooks/git-guardrail.sh");
const hook = (command) => spawnSync("sh", [wrapper], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: tmpdir() }), encoding: "utf8", env: { ...process.env, HOME: tmpdir() } });

test.each(["gh pr merge 5 --squash", "cd x && sh -c 'gh pr merge 5'", "gh api -X PUT repos/o/r/pulls/5/merge"])("the hook blocks %s", (line) => {
  const r = hook(line);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("blocked a direct merge");
  expect(r.stderr).toContain("merge-gate.mjs merge");
});

test.each(["gh pr view 5", "git commit -m 'never run gh pr merge'", "node x/merge-gate.mjs merge --repo o/r --pr 5 --sha abc"])("the hook passes %s", (line) => {
  expect(hook(line).status).toBe(0);
});

// The corpus is lines that should block or pass: "seen" from earlier reviewers,
// "fresh" written before this reader first ran, "tests" from its own tests,
// "unseen" by an agent that had not read it, "ordinary" and "runners" around
// lines a review found wrongly blocked. A recorded miss is a direct merge that
// passes, a false block the reverse. A case keeps its place and label, and one
// that was read right stays right.
const CORPUS = "tests/direct-merge-corpus.json";
const corpus = JSON.parse(readFileSync(join(root, CORPUS), "utf8"));

// The ways `head` is looser than `base`; empty when it holds or improves.
function loosened(base, head) {
  const problems = [];
  for (const [set, was] of Object.entries(base)) {
    const now = head[set];
    if (!now) problems.push(`${set}: removed`);
    else {
      for (const label of ["block", "pass"]) for (const cmd of was[label]) if (!now[label].includes(cmd)) problems.push(`${set}: ${label} case removed or relabelled: ${cmd}`);
      for (const list of ["misses", "falseBlocks"]) for (const cmd of now[list]) if (!was[list].includes(cmd)) problems.push(`${set}: ${list} gains ${cmd}`);
    }
  }
  return problems;
}

test.each(Object.entries(corpus))("the corpus's %s lines are read as recorded", (_, { block, pass, misses, falseBlocks }) => {
  expect(new Set([...block, ...pass]).size).toBe(block.length + pass.length);
  expect(block.filter((cmd) => !directMerge(cmd))).toEqual(misses);
  expect(pass.filter((cmd) => directMerge(cmd))).toEqual(falseBlocks);
});

test("the corpus's misses and false blocks only go down from the base's", () => {
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  // CI checks out the merge commit and its parents, without origin/main.
  const found = git("merge-base", "origin/main", "HEAD");
  const base = git("show", `${found.status === 0 ? found.stdout.trim() : "HEAD^1"}:${CORPUS}`);
  if (base.status === 0) expect(loosened(JSON.parse(base.stdout), corpus)).toEqual([]);
});

test("the corpus's bar sees a removed case, a moved label, and a rise", () => {
  const seen = { block: ["a", "b"], pass: ["c"], misses: ["b"], falseBlocks: [] };
  expect(loosened({ seen }, { seen })).toEqual([]);
  expect(loosened({ seen }, { seen: { ...seen, block: ["a", "b", "d"], misses: [] }, more: seen })).toEqual([]);
  expect(loosened({ seen }, {})).toEqual(["seen: removed"]);
  expect(loosened({ seen }, { seen: { ...seen, block: ["a"], pass: ["c", "b"], misses: [] } })).toEqual(["seen: block case removed or relabelled: b"]);
  expect(loosened({ seen }, { seen: { ...seen, misses: ["a"], falseBlocks: ["c"] } })).toEqual(["seen: misses gains a", "seen: falseBlocks gains c"]);
});
