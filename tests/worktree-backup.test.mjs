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

  // Regression cases from the independent verifier of #10.
  test("untracked files under a tracked build or dist folder are kept, only ignored ones there are left", () => {
    const { repo, wt, git, run } = setup();
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build/release.sh"), "r\n");
    git(repo, "add", "build/release.sh");
    git(repo, "commit", "-q", "-m", "build script");
    git(wt, "merge", "-q", "main");
    writeFileSync(join(wt, "build/deploy.sh"), "d\n");
    mkdirSync(join(wt, "docs/dist"), { recursive: true });
    writeFileSync(join(wt, "docs/dist/notes.md"), "n\n");
    mkdirSync(join(wt, "node_modules"));
    writeFileSync(join(wt, "node_modules/x.js"), "x\n");
    const r = run();
    const listed = execFileSync("tar", ["-tzf", r.json.tarball.path], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(listed).toEqual(["build/deploy.sh", "docs/dist/notes.md"]);
  });

  test("an index-only version is kept beside the version on disk", () => {
    const { wt, git, run } = setup();
    writeFileSync(join(wt, "a.txt"), "staged\n");
    git(wt, "add", "a.txt");
    writeFileSync(join(wt, "a.txt"), "staged\nlater\n");
    writeFileSync(join(wt, "p.txt"), "only staged\n");
    git(wt, "add", "p.txt");
    rmSync(join(wt, "p.txt"));
    const r = run();
    const tip = r.json.branches[0].branch;
    expect(git(wt, "show", `${tip}:a.txt`)).toBe("staged\nlater");
    expect(git(wt, "show", `${tip}~1:a.txt`)).toBe("staged");
    expect(git(wt, "show", `${tip}~1:p.txt`)).toBe("only staged");
  });

  function withSubmodule() {
    const ctx = setup();
    const { root, repo, git } = ctx;
    const lib = join(root, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q", "-b", "main");
    writeFileSync(join(lib, ".gitignore"), ".env\n");
    writeFileSync(join(lib, "lib.txt"), "l\n");
    git(lib, "add", ".");
    git(lib, "commit", "-q", "-m", "lib");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
    git(repo, "commit", "-q", "-m", "add sub");
    const wt2 = join(root, "wt2");
    git(repo, "worktree", "add", "-q", "-b", "sub-feature", wt2);
    const run2 = (...args) => {
      const r = spawnSync("node", [script, wt2, "--trash", join(root, "trash"), "--date", "2026-11-21", ...args], { encoding: "utf8", env });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    return { ...ctx, wt2, run2 };
  }

  test("an uninitialized submodule does not hold a clean worktree", () => {
    const { run2 } = withSubmodule();
    expect(run2().json.kind).toBe("nothing-to-back-up");
  });

  test("an ignored file or a local commit inside an initialized submodule holds the worktree", () => {
    const { wt2, git, run2 } = withSubmodule();
    git(wt2, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    writeFileSync(join(wt2, "sub/.env"), "SECRET=fixture\n");
    expect(run2().json).toMatchObject({ kind: "hold", reason: "submodules with work that removal would lose: sub" });
    rmSync(join(wt2, "sub/.env"));
    git(join(wt2, "sub"), "switch", "-q", "-c", "local-work");
    writeFileSync(join(wt2, "sub/new.txt"), "n\n");
    git(join(wt2, "sub"), "add", "new.txt");
    git(join(wt2, "sub"), "commit", "-q", "-m", "local");
    git(join(wt2, "sub"), "switch", "-q", "--detach", "HEAD~1");
    expect(run2().json.kind).toBe("hold");
  });

  test("a submodule commit on its detached HEAD, staged in the parent, holds the worktree", () => {
    const { wt2, git, run2 } = withSubmodule();
    git(wt2, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    const sub = join(wt2, "sub");
    writeFileSync(join(sub, "lib.txt"), "changed\n");
    git(sub, "commit", "-q", "-am", "detached submodule work");
    git(wt2, "add", "sub");
    expect(run2().json).toMatchObject({ kind: "hold", reason: "submodules with work that removal would lose: sub" });
  });

  test("a stash inside an initialized submodule holds the worktree", () => {
    const { wt2, git, run2 } = withSubmodule();
    git(wt2, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    const sub = join(wt2, "sub");
    writeFileSync(join(sub, "lib.txt"), "stashed\n");
    git(sub, "stash", "-q");
    expect(run2().json.kind).toBe("hold");
  });

  test("a commit kept only by a per-worktree ref gets a backup branch", () => {
    const { wt, git, run } = setup();
    git(wt, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "k.txt"), "k\n");
    git(wt, "add", "k.txt");
    git(wt, "commit", "-q", "-m", "kept by a worktree ref");
    const kept = git(wt, "rev-parse", "HEAD");
    git(wt, "update-ref", "refs/worktree/keep", kept);
    git(wt, "checkout", "-q", "feature");
    expect(run().json.branches.map((b) => b.commit)).toContain(kept);
  });

  test("a merge in progress with conflicts is held, not crashed on", () => {
    const { repo, wt, git, run } = setup();
    writeFileSync(join(repo, "a.txt"), "main side\n");
    git(repo, "commit", "-q", "-am", "main side");
    writeFileSync(join(wt, "a.txt"), "feature side\n");
    git(wt, "commit", "-q", "-am", "feature side");
    spawnSync("git", ["-C", wt, "merge", "main"], { env });
    const r = run();
    expect(r.status).toBe(3);
    expect(r.json.reason).toContain("unmerged paths");
  });

  test("a worktree with no commit yet is held, not crashed on", () => {
    const { root, repo, git } = setup();
    const orphan = join(root, "orphan");
    git(repo, "worktree", "add", "-q", "--orphan", "-b", "fresh", orphan);
    writeFileSync(join(orphan, "x.txt"), "x\n");
    const r = spawnSync("node", [script, orphan, "--trash", join(root, "trash")], { encoding: "utf8", env });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).reason).toContain("no commit yet");
  });

  test("a folder name git would refuse as a branch still gets a valid backup branch", () => {
    const { root, repo, git } = setup();
    const odd = join(root, "my wt.lock");
    git(repo, "worktree", "add", "-q", "-b", "odd", odd);
    writeFileSync(join(odd, "a.txt"), "changed\n");
    const r = spawnSync("node", [script, odd, "--trash", join(root, "trash"), "--date", "2026-11-21"], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).branches[0].branch).toBe("backup/my-wt-2026-11-21");
  });

  test("a path inside a worktree is refused, so nothing outside it is missed", () => {
    const { wt } = setup();
    mkdirSync(join(wt, "src"));
    const r = spawnSync("node", [script, join(wt, "src")], { encoding: "utf8", env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not its top level");
  });

  test("usage errors exit 2", () => {
    expect(spawnSync("node", [script], { encoding: "utf8" }).status).toBe(2);
    const { run } = setup();
    expect(run("--keep-days", "0").status).toBe(2);
  });
});
