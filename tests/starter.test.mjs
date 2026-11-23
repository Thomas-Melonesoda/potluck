// potluck: the new-project starter (stage 5 issue 10) in
// plugins/pstack/skills/grill/scripts/starter.mjs, run on scratch repositories.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardSource } from "../plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs";
import { main, NO_CHECK, start } from "../plugins/pstack/skills/grill/scripts/starter.mjs";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const roots = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "potluck-starter-"));
  roots.push(root);
  return root;
};
const git = (root, args, extra = {}) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...env, ...extra } });
const repo = () => {
  const root = scratch();
  git(root, ["init", "-q", "-b", "main"]);
  return root;
};
const read = (root, path) => readFileSync(join(root, path), "utf8");

describe("a new repository", () => {
  const root = repo();
  const lines = start(root, { name: "Split bills", check: "npm run check" });

  test("gets CI that runs the check on every pull request and on main", () => {
    const ci = Bun.YAML.parse(read(root, ".github/workflows/ci.yml"));
    expect("pull_request" in ci.on).toBe(true);
    expect(ci.on.push.branches).toEqual(["main"]);
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.jobs.check.steps.at(-1).run.trim()).toBe("npm run check");
    expect(ci.jobs.check.steps[0].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
  });

  test("gets an executable pre-commit hook with the floor and a secret scan, enabled", () => {
    const hook = read(root, ".githooks/pre-commit");
    expect(statSync(join(root, ".githooks/pre-commit")).mode & 0o111).not.toBe(0);
    expect(hook).toContain('node "$guard" --base HEAD');
    expect(hook).toContain("gitleaks git --pre-commit --staged --redact");
    expect(git(root, ["config", "core.hooksPath"]).stdout.trim()).toBe(".githooks");
    expect(read(root, ".git/potluck/floor-guard.mjs")).toBe(guardSource());
  });

  test("gets an AGENTS.md skeleton that names the check, and a CLAUDE.md that reads it", () => {
    const agents = read(root, "AGENTS.md");
    expect(agents.startsWith("# Split bills\n")).toBe(true);
    expect(agents).toContain("`npm run check`");
    for (const heading of ["What this is", "Where progress lives", "Layout", "Run it", "Check before saying done", "Do not touch"]) expect(agents).toContain(`## ${heading}`);
    expect(agents.split("\n").length).toBeLessThanOrEqual(60);
    expect(read(root, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(lines.filter((l) => l.startsWith("wrote "))).toHaveLength(5);
  });
});

test("an existing file is never overwritten, and a second run writes no file", () => {
  const root = repo();
  writeFileSync(join(root, "AGENTS.md"), "# mine\n");
  writeFileSync(join(root, "CLAUDE.md"), "my notes\n");
  const first = start(root, {});
  expect(read(root, "AGENTS.md")).toBe("# mine\n");
  expect(first).toContain("kept AGENTS.md, which was already there");
  expect(first).toContain("note: CLAUDE.md does not read AGENTS.md; add a line `@AGENTS.md` to it");
  const second = start(root, {});
  expect(second.filter((l) => l.startsWith("wrote .") || l.startsWith("wrote A") || l.startsWith("wrote C"))).toEqual([]);
});

test("without a check command, CI fails and says what to put there", () => {
  const root = repo();
  start(root, {});
  const run = Bun.YAML.parse(read(root, ".github/workflows/ci.yml")).jobs.check.steps.at(-1).run;
  expect(run.trim()).toBe(NO_CHECK);
  const result = spawnSync("sh", ["-c", run], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No check command yet");
  expect(read(root, "AGENTS.md")).toContain("One command runs every check (types, lint, tests, build): to confirm.");
});

test("another hooks folder is left alone, and a folder outside git gets the files and a note", () => {
  const root = repo();
  git(root, ["config", "core.hooksPath", ".husky"]);
  expect(start(root, {}).at(-1)).toContain("core.hooksPath is .husky");
  expect(git(root, ["config", "core.hooksPath"]).stdout.trim()).toBe(".husky");
  const plain = scratch();
  expect(start(plain, {}).at(-1)).toContain("not a git repository");
  expect(existsSync(join(plain, ".githooks/pre-commit"))).toBe(true);
});

describe("the hook", () => {
  // A stand-in gitleaks: fails when the staged change holds the word LEAKED.
  const bin = scratch();
  writeFileSync(join(bin, "gitleaks"), '#!/bin/sh\nif git diff --cached | grep -q LEAKED; then echo "leaks found" >&2; exit 1; fi\n');
  chmodSync(join(bin, "gitleaks"), 0o755);
  const path = { PATH: `${bin}:${process.env.PATH}` };
  const commit = (root, file, text) => {
    writeFileSync(join(root, file), text);
    git(root, ["add", file]);
    return git(root, ["commit", "-q", "-m", file], path);
  };

  test("lets a clean commit through, and stops a suppression, a secret, or a missing guard", () => {
    const root = repo();
    start(root, { check: "true" });
    expect(commit(root, "README.md", "# Split bills\n").status).toBe(0);
    git(root, ["add", "."]);
    expect(git(root, ["commit", "-q", "-m", "starter"], path).status).toBe(0);
    const silenced = commit(root, "a.ts", "// @ts-ignore\nexport const a = 1;\n");
    expect(silenced.status).not.toBe(0);
    expect(silenced.stderr).toContain("[silenced-checker] a.ts");
    git(root, ["rm", "-q", "--cached", "a.ts"]);
    rmSync(join(root, "a.ts"));
    expect(commit(root, "b.ts", "export const b = 2;\n").status).toBe(0);
    const leaked = commit(root, "c.ts", 'export const key = "LEAKED";\n');
    expect(leaked.status).not.toBe(0);
    expect(leaked.stderr).toContain("leaks found");
    git(root, ["rm", "-q", "--cached", "c.ts"]);
    rmSync(join(root, "c.ts"));
    rmSync(join(root, ".git/potluck/floor-guard.mjs"));
    const unguarded = commit(root, "d.ts", "export const d = 4;\n");
    expect(unguarded.status).not.toBe(0);
    expect(unguarded.stderr).toContain("no floor guard");
  });
});

test("usage errors exit 2", () => {
  expect(main(["--check", ""])).toBe(2);
  expect(main(["--check", "a\nb"])).toBe(2);
  expect(main(["--nope"])).toBe(2);
  const missing = join(scratch(), "nowhere");
  expect(main(["--root", missing])).toBe(2);
  mkdirSync(missing);
});
