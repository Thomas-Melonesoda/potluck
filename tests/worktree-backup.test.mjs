// potluck: worktree-backup.mjs (C3) saves what `git worktree remove` would
// lose, so an agent can delete a worktree without asking and still undo it.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/worktree-backup.mjs");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const roots = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "potluck-backup-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feature", wt);
  const run = (...args) => {
    const r = spawnSync("node", [script, wt, "--trash", join(root, "trash"), "--date", "2026-11-21", ...args], { encoding: "utf8", env });
    return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  return { root, repo, wt, git, run, trash: join(root, "trash") };
}

describe("worktree-backup", () => {
  test("saves tracked edits, staged new files, untracked and ignored files, and leaves the worktree as it was", () => {
    const { wt, git, run } = setup();
    writeFileSync(join(wt, "a.txt"), "two\n");
    writeFileSync(join(wt, "staged.txt"), "staged\n");
    git(wt, "add", "staged.txt");
    writeFileSync(join(wt, "notes.txt"), "untracked\n");
    writeFileSync(join(wt, ".env"), "TOKEN=fixture\n");
    mkdirSync(join(wt, "node_modules"));
    writeFileSync(join(wt, "node_modules/big.js"), "x\n");
    const before = git(wt, "status", "--porcelain", "--ignored");

    const r = run();

    expect(r.status).toBe(0);
    expect(r.json.kind).toBe("backed-up");
    expect(git(wt, "status", "--porcelain", "--ignored")).toBe(before);
    const wip = r.json.branches.find((b) => b.holds === "uncommitted changes");
    expect(wip.branch).toBe("backup/wt-2026-11-21");
    expect(git(wt, "show", `${wip.branch}:a.txt`)).toBe("two");
    expect(git(wt, "show", `${wip.branch}:staged.txt`)).toBe("staged");
    expect(git(wt, "ls-tree", "-r", "--name-only", wip.branch)).not.toContain(".env");
    const listed = execFileSync("tar", ["-tzf", r.json.tarball.path], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(listed).toEqual([".env", "notes.txt"]);
  });

  test("a commit only HEAD reaches gets a branch, and a second run the same day does not overwrite the first", () => {
    const { wt, git, run } = setup();
    git(wt, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "-m", "detached work");
    const head = git(wt, "rev-parse", "HEAD");

    const first = run();
    expect(first.json.branches).toContainEqual({ branch: "backup/wt-2026-11-21-head", commit: head, holds: "commits only HEAD reached" });

    writeFileSync(join(wt, "b.txt"), "changed\n");
    const second = run();
    expect(second.json.branches.map((b) => b.branch)).toEqual(["backup/wt-2026-11-21"]);
    writeFileSync(join(wt, "b.txt"), "changed again\n");
    expect(run().json.branches.map((b) => b.branch)).toEqual(["backup/wt-2026-11-21-2"]);
  });

  test("a commit only the HEAD reflog reaches gets a branch at its tip", () => {
    const { wt, git, run } = setup();
    writeFileSync(join(wt, "c.txt"), "c\n");
    git(wt, "add", "c.txt");
    git(wt, "commit", "-q", "-m", "will be dropped");
    const dropped = git(wt, "rev-parse", "HEAD");
    git(wt, "reset", "-q", "--hard", "HEAD~1");

    const r = run();
    expect(r.json.branches).toEqual([
      { branch: `backup/wt-2026-11-21-reflog-${dropped.slice(0, 7)}`, commit: dropped, holds: "commits only the HEAD reflog reached" },
    ]);
  });

  test("a clean worktree has nothing to back up", () => {
    const { run } = setup();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.json.kind).toBe("nothing-to-back-up");
  });

  test("a locked worktree is held and nothing is written", () => {
    const { repo, wt, git, run, trash } = setup();
    writeFileSync(join(wt, "a.txt"), "two\n");
    git(repo, "worktree", "lock", "--reason", "agent 7 is using it", wt);
    const r = run();
    expect(r.status).toBe(3);
    expect(r.json).toEqual({ kind: "hold", worktree: wt, reason: "locked: agent 7 is using it" });
    expect(git(repo, "branch", "--list", "backup/*")).toBe("");
    expect(() => readdirSync(trash)).toThrow();
  });

  test("trash older than --keep-days is pruned, newer trash stays", () => {
    const { run, trash } = setup();
    mkdirSync(join(trash, "2026-10-01"), { recursive: true });
    mkdirSync(join(trash, "2026-11-20"), { recursive: true });
    const r = run("--keep-days", "30");
    expect(r.json.prunedTrash).toEqual(["2026-10-01"]);
    expect(readdirSync(trash).sort()).toEqual(["2026-11-20"]);
  });

  test("usage errors exit 2", () => {
    expect(spawnSync("node", [script], { encoding: "utf8" }).status).toBe(2);
    const { run } = setup();
    expect(run("--keep-days", "0").status).toBe(2);
  });
});
