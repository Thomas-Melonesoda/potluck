// potluck: worktree-remove.mjs (S3-C3, stage 5 issue 6) deletes a worktree only
// after its backup checks out, by moving it to the trash, and only when the
// path is a linked worktree's top level.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeBackedUp } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-remove.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/worktree-remove.mjs");
const backupScript = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/worktree-backup.mjs");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const roots = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "potluck-remove-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feature", wt);
  const trash = join(root, "trash");
  const run = (path = wt, ...args) => {
    const r = spawnSync("node", [script, path, "--trash", trash, "--date", "2026-11-21", ...args], { encoding: "utf8", env });
    return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  const listed = () => git(repo, "worktree", "list", "--porcelain");
  // The backup runs as its own process, so its commits get the test's identity.
  const backedUp = () => JSON.parse(execFileSync("node", [backupScript, wt, "--trash", trash, "--date", "2026-11-21"], { encoding: "utf8", env }));
  return { root, repo, wt, git, run, trash, listed, backedUp };
}

describe("worktree-remove", () => {
  test("backs up, checks the backup, and moves the worktree to the trash instead of deleting it", () => {
    const { repo, wt, git, run, trash, listed } = setup();
    writeFileSync(join(wt, "a.txt"), "two\n");
    writeFileSync(join(wt, "notes.txt"), "untracked\n");
    writeFileSync(join(wt, ".env"), "TOKEN=fixture\n");
    mkdirSync(join(trash, "2026-01-01", "old-wt"), { recursive: true });
    // Another worktree whose folder went missing keeps git's record of it.
    git(repo, "worktree", "add", "-q", "-b", "other", join(repo, "../other"));
    renameSync(join(repo, "../other"), join(repo, "../other-moved"));

    const r = run();

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.json.kind).toBe("removed");
    expect(existsSync(wt)).toBe(false);
    expect(r.json.trashed.startsWith(join(trash, "2026-11-21", "wt-"))).toBe(true);
    expect(readFileSync(join(r.json.trashed, "notes.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(r.json.trashed, ".env"), "utf8")).toBe("TOKEN=fixture\n");
    expect(listed()).not.toContain(wt);
    expect(listed()).toContain("other");
    // The trashed folder no longer points at git's record, which a new
    // worktree of the same name would reuse.
    expect(existsSync(join(r.json.trashed, ".git"))).toBe(false);
    git(repo, "worktree", "add", "-q", "-b", "again", wt);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("again");
    expect(git(repo, "show", "backup/wt-2026-11-21:a.txt")).toBe("two");
    expect(git(repo, "branch", "--list", "feature")).toContain("feature");
    // The trash is cleared by its retention period, moved worktrees included.
    expect(readdirSync(trash)).toEqual(["2026-11-21"]);
  });

  test("a clean worktree is moved too, and an untracked repository inside one is checked file by file", () => {
    const { wt, git, run } = setup();
    expect(run().json.kind).toBe("removed");
    const second = setup();
    mkdirSync(join(second.wt, "vendor/lib"), { recursive: true });
    git(join(second.wt, "vendor/lib"), "init", "-q");
    writeFileSync(join(second.wt, "vendor/lib/x.c"), "int x;\n");
    symlinkSync("x.c", join(second.wt, "vendor/lib/y.c"));
    const r = second.run();
    expect(r.stderr).toBe("");
    expect(r.json.kind).toBe("removed");
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(second.wt)).toBe(false);
  });

  test("a path that is not a linked worktree's top level is refused, and nothing moves", () => {
    const { root, repo, wt, run } = setup();
    mkdirSync(join(wt, "src"));
    const plain = join(root, "plain");
    mkdirSync(plain);
    for (const [path, says] of [
      [repo, "is the main worktree"],
      [join(wt, "src"), "not the top level of a linked worktree"],
      [root, "not the top level of a linked worktree"],
      [plain, "not the top level of a linked worktree"],
    ]) {
      const r = run(path);
      expect(r.status, path).toBe(2);
      expect(r.stderr, path).toContain(says);
    }
    for (const name of ["trash", "..trash"]) {
      const inside = spawnSync("node", [script, wt, "--trash", join(wt, name)], { encoding: "utf8", env });
      expect(inside.status, name).toBe(2);
      expect(inside.stderr, name).toContain("inside the worktree");
      expect(existsSync(join(wt, name)), name).toBe(false);
    }
    expect(existsSync(join(wt, "src"))).toBe(true);
    expect(existsSync(join(repo, ".git"))).toBe(true);
  });

  test("a symlink to a worktree moves the worktree, not the link", () => {
    const { root, wt, run } = setup();
    const link = join(root, "link");
    symlinkSync(wt, link);
    const r = run(link);
    expect(r.json.kind).toBe("removed");
    expect(existsSync(wt)).toBe(false);
  });

  test("a backup that does not match the worktree holds it, and nothing moves", async () => {
    const { wt, git, trash, backedUp } = setup();
    writeFileSync(join(wt, "a.txt"), "two\n");
    writeFileSync(join(wt, "notes.txt"), "untracked\n");
    const options = { trash, keepDays: 30, date: "2026-11-21" };

    const moved = backedUp();
    git(wt, "branch", "-f", moved.branches[0].branch, "HEAD");
    const branch = await removeBackedUp(wt, moved, options);
    expect(branch.kind).toBe("hold");
    expect(branch.reason).toContain(`backup branch ${moved.branches[0].branch} points at`);

    const grown = backedUp();
    writeFileSync(join(wt, "notes.txt"), "untracked, and longer\n");
    const size = await removeBackedUp(wt, grown, options);
    expect(size.kind).toBe("hold");
    expect(size.reason).toContain("notes.txt");

    const extra = backedUp();
    writeFileSync(join(wt, "late.txt"), "written after the backup\n");
    const count = await removeBackedUp(wt, extra, options);
    expect(count.kind).toBe("hold");
    expect(count.reason).toContain("the tarball holds 2 files and the worktree has 3");
    expect(existsSync(join(wt, "notes.txt"))).toBe(true);
   }, 30_000);

  test("a moved worktree with a read-only folder is still cleared when its trash expires", () => {
    const { run, trash } = setup();
    const folder = join(trash, "2026-01-01", "old-wt", "go-mod-cache");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "f.go"), "package f\n");
    chmodSync(folder, 0o555);
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.json.kind).toBe("removed");
    expect(r.json.backup.prunedTrash).toEqual(["2026-01-01"]);
    expect(readdirSync(trash)).toEqual(["2026-11-21"]);
  });

  test("an expired trash entry that cannot be cleared is reported, and the cleanup goes on", () => {
    const { run, trash } = setup();
    mkdirSync(join(trash, "2026-11-21"), { recursive: true });
    mkdirSync(join(trash, "2026-01-01", "old-wt"), { recursive: true });
    chmodSync(trash, 0o555);
    try {
      const r = run();
      expect(r.stderr).toBe("");
      expect(r.json.kind).toBe("removed");
      expect(r.json.backup.trashNotCleared.map((e) => e.entry)).toEqual(["2026-01-01"]);
    } finally {
      chmodSync(trash, 0o755);
    }
  });

  test("a sparse file is read at its real size", () => {
    const { wt, run } = setup();
    writeFileSync(join(wt, "big.bin"), "");
    truncateSync(join(wt, "big.bin"), 8 * 1024 * 1024);
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.json.kind).toBe("removed");
  });

  // From the independent verifier of #38.
  test("a worktree path crafted to look like another record does not open the main checkout", () => {
    const { root, repo, git, run } = setup();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "main.c"), "int main;\n");
    git(repo, "worktree", "add", "-q", "-b", "evil", `${join(root, "x")}\nworktree ${join(repo, "src")}`);
    const r = run(join(repo, "src"));
    expect(r.status).toBe(2);
    expect(existsSync(join(repo, "src", "main.c"))).toBe(true);
  });

  test("a recorded path that is a symlink, a trash path through a dangling link, and a worktree inside the trash are refused", () => {
    const { root, repo, wt, git, trash } = setup();
    const cli = (path, trashPath) => spawnSync("node", [script, path, "--trash", trashPath, "--date", "2026-11-21"], { encoding: "utf8", env });
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    expect(cli(wt, join(root, "dangling", "t")).status).toBe(2);
    const inTrash = join(trash, "2026-01-01", "kept");
    mkdirSync(join(trash, "2026-01-01"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "kept", inTrash);
    const r = cli(inTrash, trash);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("inside the trash");
    expect(existsSync(join(inTrash, "a.txt"))).toBe(true);
    renameSync(wt, join(root, "wt-real"));
    symlinkSync(join(root, "wt-real"), wt);
    const linked = cli(wt, trash);
    expect(linked.status).toBe(2);
    expect(linked.stderr).toContain("symlink");
    expect(existsSync(join(root, "wt-real", "a.txt"))).toBe(true);
  });

  test("an untracked .git.removed in the worktree is kept, not overwritten or crashed on", () => {
    const { wt, run } = setup();
    mkdirSync(join(wt, ".git.removed"));
    writeFileSync(join(wt, ".git.removed", "mine.txt"), "mine\n");
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.json.kind).toBe("removed");
    expect(readFileSync(join(r.json.trashed, ".git.removed", "mine.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(r.json.trashed, ".git"))).toBe(false);
  });

  // From the independent verifier of #42.
  test("a locked worktree is held even when its path holds a newline", () => {
    const { root, repo, git, trash } = setup();
    const odd = join(root, "wt\ntail");
    git(repo, "worktree", "add", "-q", "-b", "odd", odd);
    writeFileSync(join(odd, "u.txt"), "mine\n");
    git(repo, "worktree", "lock", "--reason", "agent 7 is using it", odd);
    const r = spawnSync("node", [script, odd, "--trash", trash, "--date", "2026-11-21"], { encoding: "utf8", env });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).reason).toBe("locked: agent 7 is using it");
    expect(existsSync(join(odd, "u.txt"))).toBe(true);
  });

  test("removal does not need `git worktree list -z`, which git added in 2.36", () => {
    const { root, wt, trash } = setup();
    const shim = join(root, "shim");
    mkdirSync(shim);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" worktree list "*" -z "*) echo "error: unknown switch" >&2; exit 129;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const r = spawnSync("node", [script, wt, "--trash", trash, "--date", "2026-11-21"], { encoding: "utf8", env: { ...env, PATH: `${shim}:${env.PATH}` } });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).kind).toBe("removed");
  });

  // From the second independent verifier of #42.
  test("a worktree whose gitdir file holds a relative path is removed", () => {
    const { root, repo, git, trash, listed } = setup();
    const rel = join(root, "rel");
    git(repo, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "-b", "rel", rel);
    writeFileSync(join(rel, "u.txt"), "mine\n");
    const r = spawnSync("node", [script, rel, "--trash", trash, "--date", "2026-11-21"], { encoding: "utf8", env });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).kind).toBe("removed");
    expect(listed()).not.toContain("rel");
  });

  test("a folder of the main checkout holding a copy of a worktree's .git file is refused", () => {
    const { repo, wt, run } = setup();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "main.c"), "int main;\n");
    writeFileSync(join(repo, "src", ".git"), readFileSync(join(wt, ".git")));
    const r = run(join(repo, "src"));
    expect(r.status).toBe(2);
    expect(existsSync(join(repo, "src", "main.c"))).toBe(true);
  });

  test("a lock taken after the backup leaves git's record, reported, and the run does not crash", async () => {
    const { repo, wt, git, trash, backedUp, listed } = setup();
    writeFileSync(join(wt, "u.txt"), "mine\n");
    const result = backedUp();
    git(repo, "worktree", "lock", "--reason", "taken late", wt);
    const r = await removeBackedUp(wt, result, { trash, date: "2026-11-21" });
    expect(r.kind).toBe("removed");
    expect(r.recordKept).toContain("locked");
    expect(listed()).toContain("locked");
  });

  test("a hold from the backup moves nothing", () => {
    const { repo, wt, git, run } = setup();
    git(repo, "worktree", "lock", "--reason", "agent 7 is using it", wt);
    const r = run();
    expect(r.status).toBe(3);
    expect(r.json).toEqual({ kind: "hold", worktree: wt, reason: "locked: agent 7 is using it" });
    expect(existsSync(wt)).toBe(true);
  });

  test("usage errors exit 2", () => {
    expect(spawnSync("node", [script], { encoding: "utf8" }).status).toBe(2);
    const { run } = setup();
    expect(run(undefined, "--keep-days", "0").status).toBe(2);
  });
});
