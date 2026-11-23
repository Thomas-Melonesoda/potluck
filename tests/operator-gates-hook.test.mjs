// potluck: the operator's gates hook (stage 5 issue 8) in
// plugins/pstack/hooks/operator-gates.mjs. With "foreignRepos": "ask", a gh
// write aimed at a repository the gh account and its organizations do not own
// gets Claude Code's "ask" decision. A fake gh on PATH answers for the account
// and for the repository the checkout resolves to, and records every call.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "../plugins/pstack/hooks/operator-gates.mjs");
const dirs = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A home with the user's gates file, a git checkout to run in, and a fake gh
// that answers `api user`, `api ... user/orgs`, and `repo view` from `account`.
function setup({ gates = { foreignRepos: "ask" }, login = "me", orgs = ["our-org"], here = "me", fail = false } = {}) {
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
else if (line === "repo view --json owner") process.stdout.write(JSON.stringify({ owner: { login: process.cwd().endsWith("/foreign") ? "stranger" : ${JSON.stringify(here)} } }));
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
  test.each([
    ["gh pr comment 5 --repo me/app --body done", "the account's own repository"],
    ["gh issue create -R our-org/site --title t --body b", "an organization it belongs to"],
    ["gh pr review 5 --repo Our-Org/site --approve", "an organization, in another case"],
    ["gh pr comment 5 --body done", "the checkout's own repository, as gh resolves it"],
    ["gh api repos/me/app/issues/1/comments -f body=done", "a gh api write to its own repository"],
  ])("%s passes: %s", (command) => {
    const { run } = setup();
    expect(run(command)).toEqual({ status: 0, stderr: "", decision: null, reason: "" });
  });

  test.each([
    ["gh pr comment 5 --repo stranger/app --body hi", "`gh pr comment` may write to a repository owned by stranger"],
    ["gh issue comment 9 -R stranger/app -b hi", "`gh issue comment` may write to a repository owned by stranger"],
    ["gh issue create --repo=stranger/app --title t --body b", "`gh issue create` may write to a repository owned by stranger"],
    ["gh pr review https://github.com/stranger/app/pull/3 --approve", "`gh pr review` may write to a repository owned by stranger"],
    ["gh pr create --repo stranger/app --fill", "`gh pr create` may write to a repository owned by stranger"],
    ["gh api repos/stranger/app/issues/1/comments -f body=hi", "`gh api POST repos/stranger/app/issues/1/comments` may write to a repository owned by stranger"],
    ["gh api --method PATCH /repos/stranger/app/issues/1 -f state=closed", "`gh api PATCH repos/stranger/app/issues/1` may write"],
    ["gh api graphql -f query='mutation { addComment(input: {subjectId: \"X\", body: \"hi\"}) { clientMutationId } }'", "a GraphQL mutation, or a GraphQL query this check cannot read, does not show which repository"],
    ["cd sub && sh -c 'gh pr comment 1 -R stranger/app -b x'", "owned by stranger"],
    ["GH_REPO=stranger/app gh issue comment 1 -b x", "owned by stranger"],
    ["gh pr comment 5 --repo ghe.example.com/team/app -b x", "on ghe.example.com, which this check cannot read"],
    ['R=stranger/app; gh issue comment 1 -R "$R" -b x', "names its repository as $R, which this check cannot read"],
    ["GH_REPO=$T gh issue comment 1 -b x", "names its repository as $T, which this check cannot read"],
    ['PR=https://github.com/stranger/app/pull/1; gh pr comment "$PR" -b x', "names its pull request or issue as $PR, which this check cannot read"],
    ["gh pr comment $(cat pr.txt) -b x", "which this check cannot read"],
    ['gh api "$URL" -f body=x', "names its endpoint as $URL, which this check cannot read"],
    ["gh pr comment https://github.com/stranger/app/pull/1 -R me/app -b x", "owned by stranger"],
    ["GH_REPO=me/app gh pr review https://github.com/stranger/app/pull/1 --approve", "owned by stranger"],
    ["gh pr comment 1 -Rstranger/app -b x", "owned by stranger"],
    ["gh pr comment 1 -R=stranger/app -b x", "owned by stranger"],
    ["gh pr revert 3 --repo stranger/app", "`gh pr revert` may write to a repository owned by stranger"],
    ["gh pr update-branch 3 -R stranger/app", "`gh pr update-branch` may write to a repository owned by stranger"],
    ["nice gh issue comment 1 -R stranger/app -b x", "owned by stranger"],
    ["pushd foreign && gh pr comment 1 -b x", "owned by stranger"],
    ["GH=gh; $GH issue comment 9 --repo stranger/app -b hi", "owned by stranger"],
    ['gh issue comment 1 -R stranger/app --body "https://github.com/me/app/pull/44 fixes this"', "owned by stranger"],
    ["gh pr create -R stranger/app --title t --body https://github.com/me/app/issues/1", "owned by stranger"],
    ["cd foreign && gh pr comment 1 --body https://github.com/me/app/pull/44", "owned by stranger"],
    ["gh pr merge -sR stranger/app 1", "owned by stranger"],
    ["gh pr review 1 -aR stranger/app", "owned by stranger"],
    ["gh pr create -fR stranger/app", "owned by stranger"],
    ["gh pr close 1 -dR stranger/app", "owned by stranger"],
    ['gh api graphql -f query="$(cat m.graphql)"', "does not show which repository it writes to"],
    ['gh api graphql -f query="$Q"', "does not show which repository it writes to"],
    ["bash -c 'cd foreign && gh pr comment 1 -b hi'", "owned by stranger"],
    ["{ cd foreign; gh pr comment 1 -b hi; }", "owned by stranger"],
    ["if true; then cd foreign; fi; gh pr comment 1 -b hi", "owned by stranger"],
  ])("%s asks", (command, reason) => {
    const { run, user } = setup();
    const r = run(command);
    expect(r.decision).toBe("ask");
    expect(r.reason).toStartWith(`potluck operator's gates (foreignRepos: ask, from ${user}): `);
    expect(r.reason).toContain(reason);
  });

  test("a cd that a subshell undoes still counts, so a write from someone else's checkout asks", () => {
    const s = setup();
    const r = s.run("(cd ..); gh pr comment 1 -b hi", { cwd: join(s.work, "foreign") });
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("owned by stranger");
  });

  test("a write in a checkout gh resolves to someone else's repository asks", () => {
    const r = setup({ here: "upstream-owner" }).run("gh pr comment 5 --body hi");
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("owned by upstream-owner");
  });

  test("reads pass without asking gh anything", () => {
    const { run, calls } = setup();
    for (const command of ['gh pr view "$PR"', "gh issue list -R \"$R\"", "gh pr view 5 --repo stranger/app", "gh issue list -R stranger/app", "gh api repos/stranger/app/pulls/5", "gh api -X GET repos/stranger/app/issues -f state=open", "gh api graphql -f query='query { viewer { login } }'", "gh api graphql -F owner=me -f query='query($owner: String!) { repository(owner: $owner, name: \"app\") { id } }'", "gh pr comment --help", "git commit -m 'gh pr comment 5 --repo stranger/app'"]) {
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

  test("still blocks what the git guardrail blocks, before this check runs", () => {
    const s = setup();
    writeFileSync(join(s.work, "a.txt"), "unsaved\n");
    const r = viaWrapper(s, "git clean -fd && gh issue comment 9 --repo stranger/app -b hi");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("potluck git guardrail: blocked a clean -f");
    expect(r.stdout).toBe("");
  });
});
