// potluck: the narrow git guardrail (S4-M11) in plugins/pstack/hooks/. Each test
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

// A clone of a bare remote on `main`; with `branch`, on that feature branch,
// pushed and tracking its remote copy.
function repo(branch) {
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
  if (branch) {
    git(work, "switch", "-q", "-c", branch);
    git(work, "push", "-q", "-u", "origin", branch);
  }
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
  // On main a force push is blocked even when clean; "shared branches" below.
  test("a clean, pushed feature branch passes everything", () => {
    const { hook } = repo("feat");
    for (const c of ["git reset --hard", "git clean -fdx", "git checkout -- .", "git push --force", "git status"]) expect(hook(c).status).toBe(0);
  });

  test("uncommitted changes block the discarding calls and say how to save the work", () => {
    const { work, root, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    const r = hook("git reset --hard");
    expect(r.status).toBe(2);
    expect(r.reason).toContain("blocked a reset --hard while the repository has uncommitted changes");
    // Stage 5 issue 9: only the files this task touched, never git add -A.
    expect(r.reason).toContain("commit the files this task touched, each by name");
    expect(r.reason).toContain("git add <file>... && git commit");
    expect(r.reason).not.toContain("git add -A");
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
    // Mid-merge, the general advice to commit must not appear either.
    expect(r.reason).not.toContain("commit the files this task touched");
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
      "echo $(git reset --hard)",
      "echo `git reset --hard`",
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
    const { hook, commit } = repo("feat");
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
    expect(hooksJson.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/git-guardrail.sh"', timeout: 60 }] }]);
  });

  test("without node on PATH the wrapper lets the call run", () => {
    const r = spawnSync("/bin/sh", [join(hooks, "git-guardrail.sh")], { input: "{}", encoding: "utf8", env: { ...env, PATH: "/nonexistent" } });
    expect(r.status).toBe(0);
  });
});

// Stage 5 issue 5: others build on the default branch, so no force push may
// rewrite it, lease or not, and no agent deletes a remote branch.
describe("shared branches", () => {
  test("a force push to the default branch is blocked in a clean repository, lease or not", () => {
    const { hook } = repo();
    for (const c of [
      "git push --force-with-lease",
      "git push --force",
      "git push -f origin main",
      "git push origin +main",
      "git push origin main --force-with-lease",
      "git push --force-with-lease=main origin HEAD:main",
      "git push origin +HEAD:refs/heads/main",
      "git push --force-with-lease origin other:main",
      "git push --force-with-lease origin HEAD",
      "git push --all --force",
      "git push --mirror",
      "bash -c 'git push --force-with-lease origin main'",
    ]) expect(hook(c).status, c).toBe(2);
    const r = hook("git push --force-with-lease");
    expect(r.reason).toContain("blocked a force push to main");
    expect(r.reason).toContain("a lease does not change that");
    for (const c of ["git push", "git push origin main", "git push -n --force origin main", "git reset --hard", "git clean -fdx", "git checkout -- .", "git status"]) {
      expect(hook(c).status, c).toBe(0);
    }
  });

  test("the remote's default branch is protected whatever its name, and so are main and master", () => {
    const { root, git, work, hook } = repo("feat");
    git(work, "push", "-q", "origin", "main:trunk");
    git(join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/trunk");
    git(work, "remote", "set-head", "origin", "-a");
    expect(hook("git push --force-with-lease origin feat:trunk").status).toBe(2);
    expect(hook("git push --force-with-lease origin HEAD:master").status).toBe(2);
    expect(hook("git push --force-with-lease origin feat").status).toBe(0);
  });

  test("on a feature branch a force push with a lease passes, unless it lands on main", () => {
    const { git, work, hook, commit } = repo("feat");
    commit("rewrite");
    for (const c of ["git push --force-with-lease", "git push --force-with-lease origin feat", "git push -u --force-with-lease origin HEAD"]) {
      expect(hook(c).status, c).toBe(0);
    }
    expect(hook("git push --force-with-lease origin feat:main").status).toBe(2);
    git(work, "branch", "-q", "--set-upstream-to=origin/main");
    expect(hook("git push --force-with-lease").status).toBe(2);
  });

  // From the independent verifier of #33.
  test("a lease push of HEAD from a feature branch that tracks origin/main passes, since git writes only that branch", () => {
    const { git, work, hook } = repo();
    git(work, "switch", "-q", "-c", "feat", "origin/main");
    for (const c of ["git push --force-with-lease origin HEAD", "git push -u --force-with-lease origin HEAD", "git push --force-with-lease origin @"]) {
      expect(hook(c).status, c).toBe(0);
    }
    expect(hook("git push --force-with-lease").status).toBe(2);
  });

  test("a forced pattern refspec that covers main is blocked", () => {
    const { hook } = repo("feat");
    for (const c of ["git push --force-with-lease origin 'refs/heads/*:refs/heads/*'", "git push --force origin 'refs/heads/*'", "git push origin '+refs/heads/m*:refs/heads/m*'"]) {
      expect(hook(c).status, c).toBe(2);
    }
    expect(hook("git push --force-with-lease origin 'refs/heads/feat*:refs/heads/feat*'").status).toBe(0);
    expect(hook("git push origin 'refs/heads/*:refs/heads/*'").status).toBe(0);
  });

  test("abbreviated options, option values, and short names are read as git reads them", () => {
    const { git, work, hook } = repo();
    for (const c of ["git push --force --recurse-submodules no origin", "git push --force --receive-pack git-receive-pack origin"]) expect(hook(c).status, c).toBe(2);
    git(work, "switch", "-q", "-c", "feat");
    git(work, "push", "-q", "-u", "origin", "feat");
    for (const c of [
      "git push --force-w origin feat:main",
      "git push --force-with origin main",
      "git push origin --del feat",
      "git push --pru origin",
      "git push --mirr origin",
      "git push -ono-ci --force origin main",
      "git push --force-with-lease origin feat:heads/main",
      "git push --force-with-lease=main:$(git rev-parse origin/main) origin feat:main",
    ]) expect(hook(c).status, c).toBe(2);
    expect(hook("git push -odeploy --force-with-lease origin feat").status).toBe(0);
    git(work, "config", "push.default", "upstream");
    git(work, "branch", "-q", "--set-upstream-to=origin/main");
    expect(hook("git push --force-with-lease origin feat").status).toBe(2);
  });

  // From the second independent verifier of #33.
  test("a forced pattern over full ref names that covers main is blocked", () => {
    const { hook } = repo("feat");
    for (const c of ["git push --force origin 'refs/*:refs/*'", "git push --force-with-lease origin 'refs/*:refs/*'", "git push origin '+refs/*:refs/*'", "git push origin '+refs/h*:refs/h*'", "git push origin '+r*:r*'", "git push origin '+*:*'"]) {
      expect(hook(c).status, c).toBe(2);
    }
  });

  test("a force push whose branch is known only at run time is blocked, and a plain one passes", () => {
    const { hook } = repo("feat");
    for (const c of [
      "git push --force-with-lease origin $(git branch --show-current)",
      'git push --force-with-lease origin "HEAD:$(git rev-parse --abbrev-ref HEAD)"',
      "for b in $(git branch --format='%(refname:short)'); do git push --force-with-lease origin \"$b\"; done",
      'echo "$(git push --force origin main)"',
      "cd ~/nowhere && git push --force-with-lease origin main",
      "git push -n --no-dry-run --force-with-lease origin main",
    ]) expect(hook(c).status, c).toBe(2);
    const r = hook("git push --force-with-lease origin $(git branch --show-current)");
    expect(r.reason).toContain("name the branch plainly");
    expect(hook("git push origin $(git branch --show-current)").status).toBe(0);
  });

  test("push configuration that sends a push to main is followed, and pushes that write only tags or the current branch pass", () => {
    const { git, work, hook } = repo("feat");
    expect(hook("git push --tags --force").status).toBe(0);
    git(work, "config", "push.default", "matching");
    expect(hook("git push --force-with-lease").status).toBe(2);
    git(work, "config", "push.default", "current");
    git(work, "branch", "-q", "--set-upstream-to=origin/main");
    expect(hook("git push --force-with-lease").status).toBe(0);
    git(work, "config", "remote.origin.push", "+refs/heads/main:refs/heads/main");
    expect(hook("git push").status).toBe(2);
  });

  test("a substitution keeps its quotes and heredocs, and its commands are read in order and in their own directory", () => {
    const { work, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    for (const c of [
      'n=$(grep -c "a)" a.txt); git reset --hard',
      "msg=$(cat <<'EOF'\nfix(parser): handle a) and b); don't drop work\nEOF\n)\ngit reset --hard",
      "x=$(git reset --hard); cd /",
      "x=$(cd /); git reset --hard",
    ]) expect(hook(c).status, c).toBe(2);
    expect(hook("body=$(cat <<'EOF'\nTo undo:\n1) git reset --hard origin/main\nEOF\n)\necho \"$body\"").status).toBe(0);
  });

  // From the third independent verifier of #33.
  test("a redirect's fd number and target are not arguments of the command", () => {
    const { work, hook } = repo();
    for (const c of ["git push --force-with-lease origin 2>&1", "git push --force-with-lease 2>/dev/null", "git push --force-with-lease > push.log 2>&1", "git push --force-with-lease origin 2>&1 | tail -5", "git push --force origin &>/dev/null"]) {
      expect(hook(c).status, c).toBe(2);
    }
    expect(commands("git push origin 2>&1 >out.log <in.txt")).toEqual([["git", "push", "origin"]]);
    writeFileSync(join(work, "a.txt"), "edited\n");
    expect(hook("git checkout main 2>/dev/null").status).toBe(0);
    expect(hook("cat <<< word\ngit reset --hard").status).toBe(2);
  });

  test("a cd inside a substitution reaches the substitutions nested in it", () => {
    const { root, work, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    expect(hook(`x=$(cd ${work} && echo $(git reset --hard))`, root).status).toBe(2);
    expect(hook(`cd /; x=$(cd ${work}; y=$(git reset --hard))`, root).status).toBe(2);
  });

  test("every branch forced from an unreadable directory, a null-hash delete, and a mirror remote are blocked", () => {
    const { git, work, hook } = repo("feat");
    expect(hook('cd "$(git rev-parse --show-toplevel)" && git push --force --all origin').status).toBe(2);
    expect(hook('cd "$(git rev-parse --show-toplevel)" && git push --force origin :').status).toBe(2);
    expect(hook("git push origin 0000000000000000000000000000000000000000:refs/heads/feat").status).toBe(2);
    git(work, "config", "remote.origin.mirror", "true");
    expect(hook("git push origin").status).toBe(2);
  });

  // From the fourth independent verifier of #33.
  test("&> inside a command, a numbered heredoc, and a hyphenated heredoc tag are read as the shell reads them", () => {
    const { work, hook } = repo();
    expect(hook("git push &>/dev/null --force-with-lease origin").status).toBe(2);
    expect(hook("git push --force-with-lease origin 2<<EOF\nyes\nEOF").status).toBe(2);
    writeFileSync(join(work, "a.txt"), "edited\n");
    expect(hook("git reset &>/dev/null --hard").status).toBe(2);
    expect(hook("cat > notes.md <<'END-NOTE'\ngit reset --hard\nEND-NOTE").status).toBe(0);
  });

  test("a push remote and a full source name decide where a push goes", () => {
    const { root, git, work, hook } = repo("feat");
    git(work, "config", "push.default", "upstream");
    git(work, "branch", "-q", "--set-upstream-to=origin/main");
    expect(hook("git push --force-with-lease origin refs/heads/feat").status).toBe(2);
    git(work, "config", "push.default", "simple");
    git(work, "remote", "add", "fork", join(root, "remote.git"));
    git(work, "config", "remote.fork.push", "+refs/heads/feat:refs/heads/main");
    git(work, "config", "remote.pushDefault", "fork");
    expect(hook("git push").status).toBe(2);
    git(work, "config", "--unset", "remote.pushDefault");
    git(work, "config", "branch.feat.pushRemote", "fork");
    expect(hook("git push").status).toBe(2);
  });

  // From the independent verifier of #45.
  test("a heredoc tag is read after quote removal, and an arithmetic shift is not a heredoc", () => {
    const { work, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    for (const c of ["cat <<\\EOF\nnote\nEOF\ngit reset --hard", "cat <<E\\OF\nnote\nEOF\ngit reset --hard", "cat <<'E'OF\nnote\nEOF\ngit reset --hard", "(( x = 1 << 3 ))\ngit reset --hard"]) {
      expect(hook(c).status, c).toBe(2);
    }
    expect(hook("cat <<\\EOF\ngit reset --hard\nEOF").status).toBe(0);
  });

  // From the second independent verifier of #45.
  test("a << that is not plainly a heredoc tag hides no command after it", () => {
    const { work, hook } = repo();
    writeFileSync(join(work, "a.txt"), "edited\n");
    for (const c of ['x=1; (( x <<= 2 ))\ngit reset --hard', 'y=2; (( x = 1 << $y ))\ngit reset --hard', "cat <<$'EOF'\nx\nEOF\ngit reset --hard", 'cat <<"E\\$OF"\nx\nE$OF\ngit reset --hard']) {
      expect(hook(c).status, c).toBe(2);
    }
  });

  test("branch.<name>.pushRemote wins over remote.pushDefault", () => {
    const { root, git, work, hook } = repo("feat");
    git(work, "remote", "add", "fork", join(root, "remote.git"));
    git(work, "remote", "add", "other", join(root, "remote.git"));
    git(work, "config", "remote.fork.push", "+refs/heads/feat:refs/heads/main");
    git(work, "config", "remote.pushDefault", "fork");
    git(work, "config", "branch.feat.pushRemote", "other");
    expect(hook("git push").status).toBe(0);
    git(work, "config", "branch.feat.pushRemote", "fork");
    git(work, "config", "remote.pushDefault", "other");
    expect(hook("git push").status).toBe(2);
  });

  test("deleting a remote branch is blocked in every spelling, and deleting a tag passes", () => {
    const { hook } = repo("feat");
    for (const c of [
      "git push origin :main",
      "git push origin :feat",
      "git push origin --delete feat",
      "git push -d origin feat",
      "git push origin :refs/heads/feat",
      "git push --prune origin",
      "git push https://example.invalid/r.git :feat",
    ]) expect(hook(c).status, c).toBe(2);
    const r = hook("git push origin --delete feat");
    expect(r.reason).toContain("blocked deleting the remote branch feat");
    expect(r.reason).toContain("ask the user");
    expect(hook("git push origin :refs/tags/v1").status).toBe(0);
    expect(hook("git push origin --delete refs/tags/v1").status).toBe(0);
  });
});
