// potluck: the operator's gates hook (stage 5 issue 8) in
// plugins/pstack/hooks/operator-gates.mjs. With "foreignRepos": "ask", a gh
// call passes only when it is a read, or one plain gh command that names a
// repository the gh account or its organizations own; every other gh call gets
// Claude Code's "ask" decision. A fake gh on PATH answers for the account and
// records every call.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "../plugins/pstack/hooks/operator-gates.mjs");
const dirs = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A home with the user's gates file, a git checkout to run in, and a fake gh
// that answers `api user`, `api ... user/orgs`, and `repo view` (the checkout
// resolves to the account's own repository, foreign/ to stranger's), so a hook
// that predicted the destination from the checkout would let an unnamed write
// through.
function setup({ gates = { foreignRepos: "ask" }, login = "me", orgs = ["our-org"], fail = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "potluck-gates-hook-")));
  dirs.push(dir);
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(join(home, ".potluck"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(join(work, "foreign"), { recursive: true });
  execFileSync("git", ["init", "-q", work]);
  if (gates !== null) writeFileSync(join(home, ".potluck/gates.json"), typeof gates === "string" ? gates : JSON.stringify(gates));
  writeFileSync(
    join(dir, "bin/gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "calls"))}, JSON.stringify(args) + "\\n");
if (${fail}) { process.stderr.write("HTTP 401: Bad credentials\\n"); process.exit(1); }
const line = args.join(" ");
if (line === "api user") process.stdout.write(JSON.stringify({ login: ${JSON.stringify(login)} }));
else if (line === "api --paginate --slurp user/orgs") process.stdout.write(JSON.stringify([${JSON.stringify(orgs.map((o) => ({ login: o })))}]));
else if (line === "repo view --json owner") process.stdout.write(JSON.stringify({ owner: { login: process.cwd().endsWith("/foreign") ? "stranger" : ${JSON.stringify(login)} } }));
else process.exit(1);
`,
    { mode: 0o755 },
  );
  const run = (command, { cwd = work, env = {} } = {}) => {
    const r = spawnSync("node", [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
      encoding: "utf8",
      env: { ...process.env, GH_REPO: "", HOME: home, PATH: `${join(dir, "bin")}:${process.env.PATH}`, ...env },
    });
    const out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
    return { status: r.status, stderr: r.stderr, decision: out?.permissionDecision ?? null, reason: out?.permissionDecisionReason ?? "" };
  };
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { run, calls, work, home, bin: join(dir, "bin"), user: join(home, ".potluck/gates.json") };
}

describe("with foreignRepos: ask", () => {
  // One plain gh call, every word literal, naming an owned repository.
  test.each([
    ["gh pr comment 5 --repo me/app --body done", "the account's own repository"],
    ["gh issue create -R our-org/site --title t --body b", "an organization it belongs to"],
    ["gh pr review 5 --repo Our-Org/site --approve", "an organization, in another case"],
    ["gh api repos/me/app/issues/1/comments -f body=done", "a gh api write to its own repository"],
    ["gh pr comment https://github.com/me/app/pull/5 -b 'done?'", "a pull request URL in the account's own repository"],
    ["gh pr create --fill -R me/app", "--repo after a flag that takes no value"],
    ["gh api -iX POST repos/our-org/site/issues/1/comments -f 'body=a [b] c'", "a short-flag run on an organization's repository"],
  ])("%s passes: %s", (command) => {
    const { run } = setup();
    expect(run(command)).toEqual({ status: 0, stderr: "", decision: null, reason: "" });
  });

  test.each([
    ["gh pr comment 5 --repo stranger/app --body hi", "`gh pr comment` writes to a repository owned by stranger"],
    ["gh issue comment 9 -R stranger/app -b hi", "`gh issue comment` writes to a repository owned by stranger"],
    ["gh issue create --repo=stranger/app --title t --body b", "`gh issue create` writes to a repository owned by stranger"],
    ["gh pr review https://github.com/stranger/app/pull/3 --approve", "`gh pr review` writes to a repository owned by stranger"],
    ["gh pr create --repo stranger/app --fill", "`gh pr create` writes to a repository owned by stranger"],
    ["gh api repos/stranger/app/issues/1/comments -f body=hi", "`gh api` writes to a repository owned by stranger"],
    ["gh api --method PATCH /repos/stranger/app/issues/1 -f state=closed", "`gh api` writes to a repository owned by stranger"],
    ["gh api graphql -f query='mutation { addComment(input: {subjectId: \"X\", body: \"hi\"}) { clientMutationId } }'", "not a repos/<owner>/<name>/... path"],
    ["cd sub && sh -c 'gh pr comment 1 -R stranger/app -b x'", "is not one plain gh call"],
    ["GH_REPO=stranger/app gh issue comment 1 -b x", "is not one plain gh call"],
    ["gh pr comment 5 --repo ghe.example.com/team/app -b x", "names ghe.example.com/team/app"],
    ['R=stranger/app; gh issue comment 1 -R "$R" -b x', "is not one plain gh call"],
    ["GH_REPO=$T gh issue comment 1 -b x", "is not one plain gh call"],
    ['PR=https://github.com/stranger/app/pull/1; gh pr comment "$PR" -b x', "is not one plain gh call"],
    ["gh pr comment $(cat pr.txt) -b x", "is not one plain gh call"],
    ['gh api "$URL" -f body=x', "is not one plain gh call"],
    ["gh pr comment https://github.com/stranger/app/pull/1 -R me/app -b x", "owned by stranger"],
    ["GH_REPO=me/app gh pr review https://github.com/stranger/app/pull/1 --approve", "is not one plain gh call"],
    ["gh pr comment 1 -Rstranger/app -b x", "owned by stranger"],
    ["gh pr comment 1 -R=stranger/app -b x", "owned by stranger"],
    ["gh pr revert 3 --repo stranger/app", "`gh pr revert` writes to a repository owned by stranger"],
    ["gh pr update-branch 3 -R stranger/app", "`gh pr update-branch` writes to a repository owned by stranger"],
    ["nice gh issue comment 1 -R stranger/app -b x", "is not one plain gh call"],
    ["pushd foreign && gh pr comment 1 -b x", "is not one plain gh call"],
    ["GH=gh; $GH issue comment 9 --repo stranger/app -b hi", "which the shell fills in at run time"],
    ['gh issue comment 1 -R stranger/app --body "https://github.com/me/app/pull/44 fixes this"', "owned by stranger"],
    ["gh pr create -R stranger/app --title t --body https://github.com/me/app/issues/1", "owned by stranger"],
    ["cd foreign && gh pr comment 1 --body https://github.com/me/app/pull/44", "is not one plain gh call"],
    ["gh pr merge -sR stranger/app 1", "in a run of short flags"],
    ["gh pr review 1 -aR stranger/app", "in a run of short flags"],
    ["gh pr create -fR stranger/app", "in a run of short flags"],
    ["gh pr close 1 -dR stranger/app", "in a run of short flags"],
    ['gh api graphql -f query="$(cat m.graphql)"', "is not one plain gh call"],
    ['gh api graphql -f query="$Q"', "is not one plain gh call"],
    ["bash -c 'cd foreign && gh pr comment 1 -b hi'", "is not one plain gh call"],
    ["{ cd foreign; gh pr comment 1 -b hi; }", "is not one plain gh call"],
    ["if true; then cd foreign; fi; gh pr comment 1 -b hi", "is not one plain gh call"],
    // Owned, but gh picks the repository from the checkout: the accepted cost.
    ["gh pr comment 5 --body done", "names no repository with --repo or a URL"],
    ["gh pr comment 44 -b --repo me/app", "gives --repo right after -b, which may take it as its value"],
    ["gh pr comment 44 -b see -R me/app https://github.com/stranger/app/pull/1", "owned by stranger"],
    // Not proven reads: fields, a GraphQL query, a gh api write elsewhere.
    ["gh api -X GET repos/stranger/app/issues -f state=open", "owned by stranger"],
    ["gh api graphql -f query='query { viewer { login } }'", "not a repos/<owner>/<name>/... path"],
    ["gh api --hostname ghe.example.com repos/me/app/issues -f title=t", "a flag or form this check does not read"],
    ["gh release create v1 -R me/app", "`gh release create` is neither a read nor a write this check can place"],
    ["gh pr view 1 && gh pr comment 1 -R me/app -b hi", "is not one plain gh call"],
    ["echo issue comment 1 -R stranger/app | xargs gh", "is not one plain gh call"],
    ["eval \"$CMD\"", "which the shell fills in at run time"],
    ["sh -c \"$CMD\"", "which the shell fills in at run time"],
    ["/usr/local/bin/g? pr comment 1 -R me/app -b hi", "a pattern the shell may expand to gh"],
    ["gh pr comment 1 -R me/app -b hi 2>&1", "is not one plain gh call"],
  ])("%s asks", (command, reason) => {
    const { run, user } = setup();
    const r = run(command);
    expect(r.decision).toBe("ask");
    expect(r.reason).toStartWith(`potluck operator's gates (foreignRepos: ask, from ${user}): `);
    expect(r.reason).toContain(reason);
  });

  test("a cd that a subshell undoes still asks, since the write names no repository", () => {
    const s = setup();
    const r = s.run("(cd ..); gh pr comment 1 -b hi", { cwd: join(s.work, "foreign") });
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("is not one plain gh call");
  });

  test("a write that names no repository asks without asking gh where it goes", () => {
    const s = setup();
    const r = s.run("gh pr comment 5 --body hi");
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("names no repository with --repo or a URL");
    expect(s.calls()).toEqual([]);
  });

  test("reads pass without asking gh anything", () => {
    const { run, calls } = setup();
    for (const command of [
      'gh pr view "$PR"',
      'gh issue list -R "$R"',
      "gh pr view 5 --repo stranger/app",
      "gh issue list -R stranger/app",
      "gh api repos/stranger/app/pulls/5",
      "gh api -i repos/stranger/app/pulls/5 --jq .title",
      "gh pr comment --help",
      "gh pr checks 44 && gh pr diff 44 | head",
      "cd sub && gh pr list --state open",
      "git commit -m 'gh pr comment 5 --repo stranger/app'",
      'git commit -m "$(echo gh pr view)"',
      "echo gh pr comment 1 -R stranger/app",
      "brew upgrade gh",
      "ls *.md && cat a?.txt",
      'echo "$HOME"',
      'cat "$(git rev-parse --show-toplevel)/README.md"',
    ]) {
      expect([command, run(command).decision]).toEqual([command, null]);
    }
    expect(calls()).toEqual([]);
  });

  test("a gh account that cannot be read asks, since ownership is unknown", () => {
    const r = setup({ fail: true }).run("gh pr comment 5 --repo me/app -b x");
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("the gh account could not be read (HTTP 401: Bad credentials)");
  });
});

describe("potluck's default", () => {
  test("with no gates file, a write to someone else's repository passes and gh is never asked", () => {
    const { run, calls } = setup({ gates: null });
    expect(run("gh issue comment 9 --repo stranger/app -b hi").decision).toBe(null);
    expect(calls()).toEqual([]);
  });

  test("foreignRepos: allow passes too", () => {
    expect(setup({ gates: { foreignRepos: "allow", noCI: "wait" } }).run("gh issue create -R stranger/app -t t -b b").decision).toBe(null);
  });

  test("a gates file that cannot be read asks for every gh write until it is fixed", () => {
    const r = setup({ gates: '{"foreignRepos": "yes"}' }).run("gh pr comment 5 --repo me/app -b x");
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("the operator's gates could not be read");
    expect(r.reason).toContain('foreignRepos must be "allow" or "ask"');
  });

  test("a repository's own gates file turns the stop on for that repository", () => {
    const { run, work } = setup({ gates: null });
    mkdirSync(join(work, ".potluck"));
    writeFileSync(join(work, ".potluck/gates.json"), JSON.stringify({ foreignRepos: "ask" }));
    expect(run("gh issue comment 9 --repo stranger/app -b hi").decision).toBe("ask");
  });
});

describe("Claude Code's Bash hook, git-guardrail.sh", () => {
  const wrapper = join(import.meta.dir, "../plugins/pstack/hooks/git-guardrail.sh");
  const viaWrapper = (s, command) => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: s.work });
    return spawnSync("sh", [wrapper], { input, encoding: "utf8", env: { ...process.env, GH_REPO: "", HOME: s.home, PATH: `${s.bin}:${process.env.PATH}` } });
  };

  test("runs this check on a call the git guardrail lets through", () => {
    const r = viaWrapper(setup(), "gh issue comment 9 --repo stranger/app -b hi");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  test("reads a gh spelled with quotes, which never names gh outright", () => {
    const r = viaWrapper(setup(), "g''h issue comment 9 --repo stranger/app -b hi");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  // Every form the verdict on a4fbf6d found passing, fed through the wrapper so
  // its prefilter is covered too.
  test.each([
    "gh api -iX POST repos/cli/cli/issues/1/comments -f body=hi",
    "gh api -if body=hi repos/cli/cli/issues/1/comments",
    "gh api 'graphql?x=1' -f query='mutation { addComment(input: {subjectId: \"X\", body: \"hi\"}) { clientMutationId } }'",
    "gh api 'https://api.github.com:443/graphql' -f query='mutation { addComment(input: {subjectId: \"X\", body: \"hi\"}) { clientMutationId } }'",
    "gh api -X POST https://api.github.com:443/repos/cli/cli/issues/1/comments -f body=hi",
    "gh api -X POST repositories/212613049/issues/1/comments -f body=hi",
    "gh pr comment https://www.github.com/cli/cli/pull/1 -b hi",
    "git remote add upstream https://github.com/cli/cli.git && gh pr create --fill",
    "git remote set-url origin https://github.com/cli/cli.git && gh pr comment 1 -b hi",
    "GIT_DIR=../foreign/.git gh pr comment 1 -b hi",
    "/opt/homebrew/bin/g[h] issue comment 1 -R cli/cli -b hi",
    "nice sh -c 'gh issue comment 1 -R cli/cli -b hi'",
    "gh issue transfer 1 cli/cli",
  ])("asks for %s", (command) => {
    const r = viaWrapper(setup(), command);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  test("still blocks what the git guardrail blocks, before this check runs", () => {
    const s = setup();
    writeFileSync(join(s.work, "a.txt"), "unsaved\n");
    const r = viaWrapper(s, "git clean -fd && gh issue comment 9 --repo stranger/app -b hi");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("potluck git guardrail: blocked a clean -f");
    expect(r.stdout).toBe("");
  });
});
