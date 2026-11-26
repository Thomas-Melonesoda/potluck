// potluck: the quality floor and overview check CI runs on every pull request,
// plugins/pstack/skills/poteto-mode/scripts/floor.mjs, run on scratch
// repositories. The floor cases came from the merge gate's tests.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FLOOR_GUARD, OVERVIEW, guardSource } from "../plugins/pstack/skills/poteto-mode/scripts/floor.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/floor.mjs");

test("the floor guard's code is the one js block in the synced floor-guard.md", () => {
  const source = guardSource(FLOOR_GUARD);
  expect(source).toContain("floor-guard");
  expect(source).toContain("process.exit(1)");
  expect(() => guardSource(join(import.meta.dir, "floor.test.mjs"))).toThrow("expected one");
});

// Stage 5 issue 17, standalone: a renamed test does not hide an untracked file left at its old path.
test("the guard on its own still reads an untracked file at a renamed test's old path", () => {
  const dir = mkdtempSync(join(tmpdir(), "potluck-guard-")), out = mkdtempSync(join(tmpdir(), "potluck-guard-script-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    g("init", "-q", "-b", "main");
    mkdirSync(join(dir, "t"));
    writeFileSync(join(dir, "t/a.test.js"), `test("a", () => { ${"expect"}(1).toBe(1); });\n`);
    g("add", "."), g("commit", "-q", "-m", "base");
    g("mv", "t/a.test.js", "t/b.test.js");
    writeFileSync(join(dir, "t/a.test.js"), `test.${"skip"}("a", () => {});\n`);
    writeFileSync(join(out, "guard.mjs"), guardSource());
    const r = spawnSync(process.execPath, [join(out, "guard.mjs"), "--base", "main"], { cwd: dir, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[test-made-easier] t/a.test.js:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// Stage 5 issue 1: widening what the floor leaves unchecked loosens it, so the
// list is pinned here and each type on it must be named in the guard's register entry.
test("only plain .md goes unchecked, and the register entry names each unchecked type", () => {
  const list = guardSource().match(/^const UNCHECKED = (\[.*\]);$/m);
  const unchecked = list && JSON.parse(list[1].replaceAll("'", '"'));
  expect(unchecked).toEqual([".md"]);
  const forks = JSON.parse(readFileSync(join(import.meta.dir, "../tools/forks.json"), "utf8"));
  const { why } = forks["constraint-driven-development"]["plugins/pstack/skills/constraint-driven-development/references/floor-guard.md"];
  for (const type of unchecked) expect(why).toContain(`\`${type}\``);
});

describe("floor.mjs on a scratch repository", () => {
  const dirs = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

  // A repository whose main holds the base and whose feature branch holds the
  // PR's head. `change` is one PR file; `base` and `files` add files before and
  // in the PR; `remove` deletes base files in the PR, `move` renames one.
  function pr({ change = { path: "src/app.js", text: "export const answer = 42;\n" }, setup: { base: baseFiles = {}, files = {}, remove = [], move = null } = {} } = {}) {
    const work = mkdtempSync(join(tmpdir(), "potluck-floor-repo-"));
    dirs.push(work);
    git(work, "init", "-q", "-b", "main");
    const put = (path, text) => {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), text);
    };
    put("src/app.js", "export const answer = 41;\n");
    for (const [path, text] of Object.entries(baseFiles)) put(path, text);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    const base = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "-c", "feature");
    put(change.path, change.text);
    for (const path of remove) git(work, "rm", "-q", path);
    for (const [path, text] of Object.entries(files)) put(path, text);
    if (move) git(work, "mv", move[0], move[1]);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "change");
    const head = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "main");
    const run = ({ from = base, cosign, cwd = work } = {}) => {
      const args = [script, "--base", from, "--head", head, ...(cosign ? ["--cosign", cosign] : [])];
      const r = spawnSync("node", args, { cwd, encoding: "utf8", env: gitEnv });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    return { run, work, base, head };
  }

  test("the floor refuses a PR that adds a suppression comment, and leaves no worktree behind", () => {
    // Built in pieces, so this file does not itself add a suppression comment.
    const { run, work } = pr({ change: { path: "src/app.js", text: `// @ts-${"ignore"}\nexport const answer = 42;\n` } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/app.js"))).toBe(true);
    expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a clean change passes", () => {
    const r = pr().run();
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ kind: "pass", reasons: [] });
  });

  test("a call without --base is a usage error", () => {
    const r = spawnSync("node", [script], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: floor.mjs --base");
  });

  test("a branch cut before main gained its first CONSTRAINTS.md cannot add an exception as if it set the bar", () => {
    const repo = pr({ change: { path: "packages/a/CONSTRAINTS.md", text: "# Constraints\n\n| ID | Rule |\n|---|---|\n| W1 | no-explicit-any |\n" } });
    writeFileSync(join(repo.work, "CONSTRAINTS.md"), "# Constraints\n\n- Coverage: at least 80%\n");
    git(repo.work, "add", "CONSTRAINTS.md");
    git(repo.work, "commit", "-q", "-m", "bar");
    expect(repo.run({ from: git(repo.work, "rev-parse", "HEAD") }).json.reasons).toEqual(["floor: [new-exception] packages/a/CONSTRAINTS.md: | W1 | no-explicit-any |"]);
  });

  test("a guard that exits 2 fails: no merge base with the PR's base", () => {
    const { run, work } = pr();
    git(work, "switch", "-q", "--orphan", "lonely");
    writeFileSync(join(work, "lonely.txt"), "x\n");
    git(work, "add", "lonely.txt");
    git(work, "commit", "-q", "-m", "lonely");
    const lonely = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "main");
    const r = run({ from: lonely });
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("floor guard could not run");
  });

  test("a base the checkout does not hold fails, never passes", () => {
    const r = pr().run({ from: "f".repeat(40) });
    expect(r.status).toBe(1);
    expect(r.json.reasons[0]).toContain("floor guard could not run");
  });


  const TEST = "src/app.test.js";
  const ASSERT = `test("adds", () => { ${"expect"}(1 + 1).toBe(2); });\n`;
  const TWO = `test("adds", () => {\n  ${"expect"}(1 + 1).toBe(2);\n  ${"expect"}(2 + 2).toBe(4);\n});\n`;

  // Stage 5 issue 17: a changed assertion waits for the root agent's co-sign
  // instead of failing outright. CI passes the fingerprints co-signed for the head.
  const CHANGED = TWO.replace("toBe(4)", "toBe(5)");
  const changed = () => pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: CHANGED } } });
  const FINDING = `floor: [assertion-changed] ${TEST}: ${"expect"}(2 + 2).toBe(4);  ->  ${"expect"}(2 + 2).toBe(5);`;

  test("a changed assertion fails until the root agent co-signs it, and the hint names the comment to post", () => {
    const { run, head } = changed();
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.cosign).toMatch(/^[0-9a-f]{16}$/);
    expect(r.json.reasons[0]).toBe(FINDING);
    expect(r.json.reasons[1]).toContain("needs the root agent's co-sign");
    expect(r.json.reasons[1]).toContain(`potluck-cosign: ${head} ${r.json.cosign}`);
  });

  test("the co-signed fingerprint clears those findings", () => {
    const { run } = changed();
    const cosign = run().json.cosign;
    const r = run({ cosign: `0123456789abcdef,${cosign}` });
    expect(r.status).toBe(0);
    expect(r.json.kind).toBe("pass");
  });

  test("a co-sign of other findings does not clear these", () => {
    expect(changed().run({ cosign: "0123456789abcdef" }).json.reasons[0]).toBe(FINDING);
  });

  test("a co-sign cannot clear a removed assertion", () => {
    const repo = pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: TWO.replace(`  ${"expect"}(2 + 2).toBe(4);\n`, "") } } });
    const r = repo.run();
    expect(r.json.cosign).toBeUndefined();
    expect(r.json.reasons).toEqual([`floor: [assertion-removed] ${TEST}: ${"expect"}(2 + 2).toBe(4);`]);
  });
});
