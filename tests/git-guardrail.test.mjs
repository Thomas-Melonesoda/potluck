// potluck: the narrow git guardrail (M11) in plugins/pstack/hooks/. Each test
// builds a real repository with a bare remote and feeds the hook the JSON
// Claude Code sends before a Bash call.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commands, gitCall, risk } from "../plugins/pstack/hooks/git-guardrail.mjs";

const hooks = join(import.meta.dir, "../plugins/pstack/hooks");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const roots = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function repo() {
  const root = mkdtempSync(join(tmpdir(), "potluck-guard-"));
  roots.push(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, work);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "-u", "origin", "main");
  const hook = (command, cwd = work, script = "git-guardrail.sh") => {
    const r = spawnSync("sh", [join(hooks, script)], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), encoding: "utf8", env });
    return { status: r.status, reason: r.stderr };
  };
  const commit = (msg) => {
    writeFileSync(join(work, `${msg}.txt`), msg);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", msg);
  };
  return { root, work, git, hook, commit };
}

describe("command parsing", () => {
  test("splits compound commands and honors quotes", () => {
    expect(commands(`cd x && git commit -m "undo git reset --hard; really" || echo 'a b'`)).toEqual([
      ["cd", "x"],
      ["git", "commit", "-m", "undo git reset --hard; really"],
      ["echo", "a b"],
    ]);
  });
  test("finds git after env assignments and prefixes, and follows -C", () => {
    expect(gitCall(["FOO=1", "command", "git", "-C", "sub", "-c", "x=y", "reset", "--hard"], "/r")).toEqual({ dir: "/r/sub", sub: "reset", args: ["--hard"] });
    expect(gitCall(["gitk"], "/r")).toBe(null);
  });
  test("names only the calls that discard work", () => {
    const of = (line) => risk(gitCall(commands(line)[0], "/r"));
    expect(of("git reset --hard HEAD~1")).toBe("reset --hard");
    expect(of("git reset HEAD~1")).toBe(null);
    expect(of("git clean -fd")).toBe("clean -f");
    expect(of("git clean -nfd")).toBe(null);
    expect(of("git checkout -- a.txt")).toBe("checkout that discards changes");
    expect(of("git checkout .")).toBe("checkout that discards changes");
    expect(of("git checkout -b new")).toBe(null);
    expect(of("git switch --discard-changes main")).toBe("switch that discards changes");
    expect(of("git restore a.txt")).toBe("restore of the working tree");
    expect(of("git restore --staged a.txt")).toBe(null);
    expect(of("git push --force")).toBe("force push without a lease");
    expect(of("git push origin +main")).toBe("force push without a lease");
    expect(of("git push --force-with-lease")).toBe(null);
    expect(of("git push")).toBe(null);
    expect(of("git branch -D old")).toEqual({ branches: ["old"] });
    expect(of("git branch -d old")).toBe(null);
  });
});

describe("the hook on a real repository", () => {
  test("a clean, pushed repository passes everything", () => {
    const { hook } = repo();
    for (const c of ["git reset --hard", "git clean -fdx", "git checkout -- .", "git push --force", "git status"]) expect(hook(c).status).toBe(0);
  });

  test("uncommitted changes block the discarding calls and say how to save the work", () => {
    const { work, root, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    const r = hook("git reset --hard");
    expect(r.status).toBe(2);
    expect(r.reason).toContain("blocked a reset --hard while the repository has uncommitted changes");
    expect(r.reason).toContain("git add -A && git commit");
    expect(hook("git restore a.txt").status).toBe(2);
    expect(hook("git checkout -- a.txt").status).toBe(2);
    expect(hook(`git -C ${work} reset --hard`, root).status).toBe(2);
    expect(hook("cd work && git reset --hard", root).status).toBe(2);
    expect(hook("git restore --staged a.txt").status).toBe(0);
    expect(hook("git stash push -u -m keep").status).toBe(0);
    expect(hook("git push").status).toBe(0);
  });

  test("checkout of a path without -- is blocked, and checkout of a branch passes", () => {
    const { git, work, hook } = repo();
    git(work, "branch", "other");
    writeFileSync(join(work, "a.txt"), "edited\n");
    expect(hook("git checkout a.txt").status).toBe(2);
    expect(hook("git checkout HEAD a.txt").status).toBe(2);
    expect(hook("git checkout main a.txt").status).toBe(2);
    expect(hook("git checkout other").status).toBe(0);
    expect(hook("git checkout -").status).toBe(0);
    expect(hook("git checkout -b fresh").status).toBe(0);
  });

  test("checkout of a branch that exists only on the remote passes, since git creates it locally", () => {
    const { git, work, hook } = repo();
    git(work, "switch", "-q", "-c", "feat");
    git(work, "push", "-q", "-u", "origin", "feat");
    git(work, "switch", "-q", "main");
    git(work, "branch", "-q", "-D", "feat");
    writeFileSync(join(work, "a.txt"), "edited\n");
    expect(hook("git checkout feat").status).toBe(0);
    expect(hook("git checkout no-such-thing").status).toBe(0);
  });

  test("during a merge conflict, taking one side passes and the message says to finish or abort", () => {
    const { git, work, hook, commit } = repo();
    git(work, "switch", "-q", "-c", "side");
    writeFileSync(join(work, "a.txt"), "side\n");
    git(work, "commit", "-q", "-am", "side");
    git(work, "switch", "-q", "main");
    writeFileSync(join(work, "a.txt"), "main\n");
    git(work, "commit", "-q", "-am", "main");
    spawnSync("git", ["-C", work, "merge", "side"], { env });
    expect(hook("git checkout --theirs a.txt").status).toBe(0);
    expect(hook("git restore --ours a.txt").status).toBe(0);
    const r = hook("git reset --hard");
    expect(r.status).toBe(2);
    expect(r.reason).toContain("A merge is in progress, so do not commit to save the work");
    expect(r.reason).toContain("git merge --abort");
    expect(r.reason).not.toContain("git add -A && git commit");
  });

  test("wrapped and spelled-out forms are read too", () => {
    const { root, work, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    for (const c of [
      'bash -c "git reset --hard"',
      "sh -c 'git checkout -- a.txt'",
      "eval git reset --hard",
      "(git reset --hard)",
      "{ git reset --hard; }",
      "if true; then git reset --hard; fi",
      "timeout 10 git reset --hard",
      "git reset --hard>/dev/null",
      "git reset \\\n  --hard",
      "xargs git checkout --",
      `sh -c "bash -c 'git reset --hard'"`,
    ]) expect(hook(c).status, c).toBe(2);
    expect(hook(`git --work-tree=${work} --git-dir=${work}/.git reset --hard`, root).status).toBe(2);
    expect(hook("git push --force --force-with-lease").status).toBe(2);
  });

  test("a heredoc body is a document, not commands", () => {
    const { work, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    expect(hook("cat > notes.md <<'EOF'\nrun git checkout -- a.txt to undo\ngit reset --hard\nEOF\necho done").status).toBe(0);
    expect(hook("cat > notes.md <<EOF\nhi\nEOF\ngit reset --hard").status).toBe(2);
  });

  test("an untracked file counts as work at risk", () => {
    const { work, hook } = repo();
    writeFileSync(join(work, "notes.txt"), "mine\n");
    expect(hook("git clean -fd").status).toBe(2);
  });

  test("an unpushed commit blocks reset --hard until a backup branch holds it", () => {
    const { git, work, hook, commit } = repo();
    commit("local");
    const r = hook("git reset --hard origin/main");
    expect(r.status).toBe(2);
    expect(r.reason).toContain("1 commit(s) on HEAD that no remote, other branch, or tag holds");
    git(work, "branch", "backup/local");
    expect(hook("git reset --hard origin/main").status).toBe(0);
  });

  test("a force push without a lease is blocked while work is at risk, and a lease passes", () => {
    const { hook, commit } = repo();
    commit("local");
    const r = hook("git push --force");
    expect(r.status).toBe(2);
    expect(r.reason).toContain("--force-with-lease");
    expect(hook("git push --force-with-lease").status).toBe(0);
  });

  test("deleting a branch is blocked only while it holds commits nothing else does", () => {
    const { git, work, hook, commit } = repo();
    git(work, "switch", "-q", "-c", "topic");
    commit("topic-work");
    git(work, "switch", "-q", "main");
    const r = hook("git branch -D topic");
    expect(r.status).toBe(2);
    expect(r.reason).toContain("would delete topic, which has 1 commit(s)");
    git(work, "push", "-q", "origin", "topic");
    expect(hook("git branch -D topic").status).toBe(0);
  });

  test("outside a repository, or with input it cannot read, the call runs", () => {
    const { root } = repo();
    const plain = join(root, "plain");
    mkdirSync(plain);
    const r = spawnSync("sh", [join(hooks, "git-guardrail.sh")], { input: "not json", encoding: "utf8", env });
    expect(r.status).toBe(0);
    const { hook } = repo();
    expect(hook("git reset --hard", plain).status).toBe(0);
  });

  test("hooks.json runs the wrapper before every Bash call on Claude Code", () => {
    const hooksJson = JSON.parse(readFileSync(join(hooks, "hooks.json"), "utf8"));
    expect(hooksJson.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/git-guardrail.sh"' }] }]);
  });

  test("without node on PATH the wrapper lets the call run", () => {
    const r = spawnSync("/bin/sh", [join(hooks, "git-guardrail.sh")], { input: "{}", encoding: "utf8", env: { ...env, PATH: "/nonexistent" } });
    expect(r.status).toBe(0);
  });
});
