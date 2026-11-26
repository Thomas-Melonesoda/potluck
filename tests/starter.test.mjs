// potluck: the new-project starter (stage 5 issue 10) in
// plugins/pstack/skills/grill/scripts/starter.mjs, run on scratch repositories.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardSource } from "../plugins/pstack/skills/poteto-mode/scripts/floor.mjs";
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

describe("a project folder inside another repository", () => {
  const outer = () => {
    const root = repo();
    const inner = join(root, "inner");
    mkdirSync(inner);
    return { root, inner };
  };
  test("gets the files itself, and the outer repository is left alone", () => {
    const { root, inner } = outer();
    const run = spawnSync("node", [join(import.meta.dir, "../plugins/pstack/skills/grill/scripts/starter.mjs")], { cwd: inner, encoding: "utf8", env });
    expect(run.status).toBe(0);
    expect(existsSync(join(inner, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, ".githooks"))).toBe(false);
    expect(git(root, ["config", "core.hooksPath"]).stdout.trim()).toBe("");
    expect(existsSync(join(root, ".git/potluck"))).toBe(false);
    expect(run.stdout).toContain("is not the top of a git work tree");
  }, 30_000);
  test("--root on a subfolder does not point the repository's hooks at a folder that is not there", () => {
    const { root, inner } = outer();
    const lines = start(inner, {});
    expect(git(root, ["config", "core.hooksPath"]).stdout.trim()).toBe("");
    expect(lines.at(-1)).toContain("is not the top of a git work tree");
  });
});

test("a check command keeps its dollar signs", () => {
  const root = repo();
  const check = `echo $$ && test "$&" = ok && printf $'a\\tb'`;
  start(root, { name: "a $& b", check });
  expect(Bun.YAML.parse(read(root, ".github/workflows/ci.yml")).jobs.check.steps.at(-1).run.trim()).toBe(check);
  expect(read(root, "AGENTS.md")).toContain(`\`${check}\``);
  expect(read(root, "AGENTS.md").startsWith("# a $& b\n")).toBe(true);
});

test("CI runs on the repository's own default branch", () => {
  const root = scratch();
  git(root, ["init", "-q", "-b", "master"]);
  expect(start(root, {})).toContain("note: CI runs on pushes to master; change its branches line if the default branch is another");
  expect(Bun.YAML.parse(read(root, ".github/workflows/ci.yml")).on.push.branches).toEqual(["master"]);
});

test("a branch name with YAML's own characters stays one branch", () => {
  for (const branch of ["a,b", "{x}", "x]y", "yes"]) {
    const root = scratch();
    git(root, ["init", "-q", "-b", branch]);
    start(root, {});
    expect(Bun.YAML.parse(read(root, ".github/workflows/ci.yml")).on.push.branches).toEqual([branch]);
  }
});

test("a check command that is only part of the Check step still gets the note", () => {
  const root = repo();
  start(root, { check: "npm test" });
  expect(start(root, { check: "npm" })).toContain("note: kept .github/workflows/ci.yml, so --check was not applied; put `npm` in its Check step");
  const bare = repo();
  start(bare, {});
  expect(start(bare, { check: "exit 1" }).some((l) => l.includes("--check was not applied"))).toBe(true);
});

test("a check command already in CI gets no note", () => {
  const root = repo();
  start(root, { check: "npm test" });
  expect(start(root, { check: "npm test" }).some((l) => l.includes("--check was not applied"))).toBe(false);
});

test("--root in another letter case is still the top of its work tree", () => {
  const root = repo();
  const other = root.replace(/[a-z](?=[^/]*$)/, (c) => c.toUpperCase());
  if (other === root || !existsSync(other)) return; // a case-sensitive filesystem has no second spelling
  // Under node, as users run it: node's realpathSync keeps the case as typed.
  const run = spawnSync("node", [join(import.meta.dir, "../plugins/pstack/skills/grill/scripts/starter.mjs"), "--root", other], { encoding: "utf8", env });
  expect(run.stdout).toContain("set core.hooksPath to .githooks");
}, 30_000);

test("from a subfolder of a project, the note points at the project's top", () => {
  const root = repo();
  mkdirSync(join(root, "sub"));
  expect(start(join(root, "sub"), {}).at(-1)).toContain("run the starter from the top");
});

test("a check command given after CI exists is reported, not dropped in silence", () => {
  const root = repo();
  start(root, {});
  expect(start(root, { check: "npm test" })).toContain("note: kept .github/workflows/ci.yml, so --check was not applied; put `npm test` in its Check step");
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
  // A repository whose first commit holds the starter's files; a first commit
  // has no HEAD to compare against, so only the secret scan runs on it.
  const guarded = () => {
    const root = repo();
    start(root, { check: "true" });
    git(root, ["add", "."]);
    expect(git(root, ["commit", "-q", "-m", "starter"], path).status).toBe(0);
    return root;
  };
  // Each case spawns git, the hook, node, and the stand-in, so it gets more
  // than bun's 5 s default when the machine is loaded.
  const SLOW = 30_000;

  test("lets a clean commit through", () => {
    expect(commit(guarded(), "b.ts", "export const b = 2;\n").status).toBe(0);
  }, SLOW);
  test("stops a new suppression", () => {
    // Spelled in two parts, as tests/merge-gate.test.mjs does, so the floor
    // guard does not read this test as adding a suppression.
    const silenced = commit(guarded(), "a.ts", `// @ts-${"ignore"}\nexport const a = 1;\n`);
    expect(silenced.status).not.toBe(0);
    expect(silenced.stderr).toContain("[silenced-checker] a.ts");
  }, SLOW);
  test("stops a staged secret", () => {
    const leaked = commit(guarded(), "c.ts", 'export const key = "LEAKED";\n');
    expect(leaked.status).not.toBe(0);
    expect(leaked.stderr).toContain("leaks found");
  }, SLOW);
  test("stops when the clone has no floor guard", () => {
    const root = guarded();
    rmSync(join(root, ".git/potluck/floor-guard.mjs"));
    const unguarded = commit(root, "d.ts", "export const d = 4;\n");
    expect(unguarded.status).not.toBe(0);
    expect(unguarded.stderr).toContain("no floor guard");
  }, SLOW);
});

test("runs from a path that crosses a symlink", () => {
  const root = repo();
  const linked = join(scratch(), "starter.mjs");
  symlinkSync(join(import.meta.dir, "../plugins/pstack/skills/grill/scripts/starter.mjs"), linked);
  const run = spawnSync("node", [linked, "--root", root], { encoding: "utf8", env });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("wrote AGENTS.md");
}, 30_000);

test("usage errors exit 2", () => {
  expect(main(["--check", ""])).toBe(2);
  expect(main(["--check", "a\nb"])).toBe(2);
  expect(main(["--check", "a\rb"])).toBe(2);
  expect(main(["--check", "a\u0000b"])).toBe(2);
  expect(main(["--nope"])).toBe(2);
  const missing = join(scratch(), "nowhere");
  expect(main(["--root", missing])).toBe(2);
  mkdirSync(missing);
});
