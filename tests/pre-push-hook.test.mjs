// .githooks/pre-push keeps a push with failing tests from leaving the machine.
// A fake `bun` on PATH stands in for the suite, so these tests never run it.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const hook = join(root, ".githooks/pre-push");
// The hook runs with a PATH holding only these tools, linked into a private
// directory, so a real bun anywhere on the machine can never run the suite here.
const tools = ["bash", "env", "git", "grep", "mktemp", "rm", "tail"];

// fakeBun is the shell body of a stand-in `bun`; null leaves bun off PATH.
// extraEnv adds variables to the hook's environment, as git itself does.
function push(fakeBun, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "potluck-prepush-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of tools) symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    if (fakeBun !== null) {
      const bun = join(bin, "bun");
      writeFileSync(bun, `#!/bin/sh\necho "$@" > "${dir}/args"\nenv | grep '^GIT_' > "${dir}/gitenv"\necho "$BUN_OPTIONS" > "${dir}/bunoptions"\n${fakeBun}\n`);
      chmodSync(bun, 0o755);
    }
    const run = spawnSync(hook, ["origin", "https://example.invalid/repo.git"], {
      cwd: root,
      env: { PATH: bin, HOME: dir, TMPDIR: dir, ...extraEnv },
      encoding: "utf8",
      input: "",
    });
    const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim() : null);
    return { status: run.status, out: `${run.stdout}${run.stderr}`, args: read("args"), gitEnv: read("gitenv"), bunOptions: read("bunoptions") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pre-push hook", () => {
  test("a failing suite blocks the push and names each failing test", () => {
    const result = push('echo "(pass) one"; echo "(fail) merge gate > refuses a stale head"; echo " 1 fail"; exit 1');
    expect(result.status).not.toBe(0);
    expect(result.args).toBe("test tests/");
    expect(result.out).toContain("(fail) merge gate > refuses a stale head");
    expect(result.out).not.toContain("(pass) one");
  });

  test("a passing suite lets the push through", () => {
    const result = push('echo " 0 fail"; exit 0');
    expect(result.status).toBe(0);
    expect(result.args).toBe("test tests/");
  });

  test("the suite runs without the repository variables git exports to hooks", () => {
    // Inherited, these point the suite's own scratch repositories at this one;
    // the first real push failed 199 tests that pass when run directly.
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const result = push('echo " 0 fail"; exit 0', { GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, "index"), GIT_WORK_TREE: root });
    expect(result.status).toBe(0);
    expect(result.gitEnv).toBe("");
  });

  test("prek runs the same script, so its users get the same unset", () => {
    // prek keeps GIT_DIR for user hooks; a bare `bun test` entry there let the
    // suite act on a pushing worktree (rewrote its branch, set core.bare).
    const config = readFileSync(join(root, ".pre-commit-config.yaml"), "utf8");
    const block = config.split(/\n\s*- id: /).find((part) => part.startsWith("tests\n"));
    expect(block).toBeDefined();
    expect(block).toMatch(/\n\s+entry: \.githooks\/pre-push\n/);
    expect(block).toMatch(/\n\s+stages: \[pre-push\]/);
  });

  test("each test gets 30 s, so a slow machine does not block a push on a timeout", () => {
    // Under heavy load, git-heavy tests that take 5 to 6 s blocked pushes at bun's 5 s default.
    expect(push('echo " 0 fail"; exit 0').bunOptions).toBe("--timeout=30000");
  });

  test("without bun on PATH the push is blocked, not waved through", () => {
    const result = push(null);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("bun");
  });
});
