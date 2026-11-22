// potluck: the deterministic merge gate (A8) in
// plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs. The decision is a
// pure function; the CLI runs against a fake `gh` on PATH that answers from a
// fixture and records every call, so no test touches GitHub.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTEXT, FLOOR_GUARD, guardSource, refusals } from "../plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs");
const sha = "a".repeat(40);
const open = { state: "OPEN", isDraft: false, headRefOid: sha, mergeable: "MERGEABLE", baseRefName: "main" };
const pass = { context: CONTEXT, state: "success" };
const ci = { name: "test", status: "completed", conclusion: "success" };

describe("refusals", () => {
  test("an open PR at the verified head with a passing verdict and green CI may merge", () => {
    expect(refusals({ view: open, statuses: [pass], runs: [ci] }, sha)).toEqual([]);
  });

  test("a head with no CI at all still needs the verdict, and passes with it", () => {
    expect(refusals({ view: open, statuses: [pass], runs: [] }, sha)).toEqual([]);
    expect(refusals({ view: open, statuses: [], runs: [] }, sha)).toEqual([`no ${CONTEXT} status on ${sha}`]);
  });

  test("the newest verdict wins, so a later fail blocks an earlier pass", () => {
    const statuses = [{ context: CONTEXT, state: "failure" }, pass];
    expect(refusals({ view: open, statuses, runs: [] }, sha)).toEqual([`${CONTEXT} is failure on ${sha}`]);
  });

  test("each unmet fact is named", () => {
    const view = { ...open, state: "CLOSED", isDraft: true, mergeable: "CONFLICTING", headRefOid: "b".repeat(40) };
    const runs = [
      { name: "lint", status: "in_progress", conclusion: null },
      { name: "unit", status: "completed", conclusion: "failure" },
      { name: "docs", status: "completed", conclusion: "skipped" },
    ];
    const statuses = [pass, { context: "ci/legacy", state: "pending" }, { context: "ci/old", state: "error" }];
    expect(refusals({ view, statuses, runs }, sha)).toEqual([
      "PR is CLOSED, not OPEN",
      "PR is a draft",
      "PR conflicts with its base",
      `head is ${"b".repeat(40)}, not the verified ${sha}`,
      "status ci/legacy is still pending",
      "status ci/old is error",
      "check lint is still in_progress",
      "check unit concluded failure",
    ]);
  });
});

test("the floor guard's code is the one js block in the synced floor-guard.md", () => {
  const source = guardSource(FLOOR_GUARD);
  expect(source).toContain("floor-guard");
  expect(source).toContain("process.exit(1)");
  expect(() => guardSource(join(import.meta.dir, "merge-gate.test.mjs"))).toThrow("expected one");
});

describe("merge-gate CLI against a fake gh", () => {
  const dirs = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

  // A checkout whose origin, a bare repo named o/r, holds main and the PR head
  // at refs/pull/7/head, as GitHub does. `change` is the PR's one file.
  // `change` is one PR file; `base` and `files` add files before and in the PR;
  // `remove` deletes base files in the PR, `move` renames one; `pullRef: false`
  // leaves refs/pull/7/head out, as if GitHub had no such PR.
  function checkout(change = { path: "src/app.js", text: "export const answer = 42;\n" }, { base: baseFiles = {}, files = {}, remove = [], move = null, pullRef = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "potluck-gate-repo-"));
    dirs.push(dir);
    const remote = join(dir, "o", "r.git");
    mkdirSync(join(dir, "o"));
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    const work = join(dir, "work");
    git(dir, "clone", "-q", remote, work);
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src/app.js"), "export const answer = 41;\n");
    for (const [path, text] of Object.entries(baseFiles)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    git(work, "push", "-q", "origin", "main");
    const base = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "-c", "feature");
    writeFileSync(join(work, change.path), change.text);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    for (const path of remove) git(work, "rm", "-q", path);
    if (move) git(work, "mv", move[0], move[1]);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "change");
    const head = git(work, "rev-parse", "HEAD");
    if (pullRef) git(work, "push", "-q", "origin", "HEAD:refs/pull/7/head");
    else git(work, "push", "-q", "origin", "HEAD:refs/heads/feature");
    git(work, "switch", "-q", "main");
    return { work, base, head };
  }

  // The fake answers `pr view` with `view` (then `after` once a merge ran),
  // the statuses and check-runs endpoints with one page each, and records argv.
  // The gate runs in a fixture checkout, so the floor guard has a real PR to read.
  function fake({ view: viewOver = {}, after: afterOver, statuses = [pass], runs = [ci], fail = "", change, setup = {} } = {}) {
    const repoDir = checkout(change, setup);
    const head = repoDir.head;
    const view = { ...open, headRefOid: head, baseRefOid: repoDir.base, ...viewOver };
    const after = { state: "MERGED", headRefOid: head, mergeCommit: { oid: "c".repeat(40) }, ...afterOver };
    const dir = mkdtempSync(join(tmpdir(), "potluck-gate-"));
    dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ view, after, statuses, runs, fail }));
    writeFileSync(
      join(dir, "bin/gh"),
      `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const f = JSON.parse(fs.readFileSync(dir + "/fixture.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls", JSON.stringify(args) + "\\n");
const line = args.join(" ");
if (f.fail && line.includes(f.fail)) { process.stderr.write("HTTP 502 fixture failure\\n"); process.exit(1); }
const merged = fs.existsSync(dir + "/merged");
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify(merged ? f.after : f.view));
else if (args[0] === "pr" && args[1] === "merge") fs.writeFileSync(dir + "/merged", "");
else if (line.includes("/statuses") && !line.includes("POST")) process.stdout.write(JSON.stringify([f.statuses]));
else if (line.includes("/check-runs")) process.stdout.write(JSON.stringify([{ check_runs: f.runs }]));
else if (line.includes("POST")) process.stdout.write("{}");
`,
      { mode: 0o755 },
    );
    const run = (...args) => {
      const filled = args.map((a) => (a === SHA ? head : a));
      const r = spawnSync("node", [script, ...filled], { cwd: repoDir.work, encoding: "utf8", env: { ...gitEnv, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { run, calls, head, work: repoDir.work };
  }
  // Stands for the fixture's PR head in a command line.
  const SHA = "<head>";
  const merge = ["merge", "--repo", "o/r", "--pr", "7", "--sha", SHA];

  test("merges with --match-head-commit and never --auto, then confirms the merge", () => {
    const { run, calls, head: sha } = fake();
    const r = run(...merge);
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ kind: "merged", repo: "o/r", pr: 7, sha, mergeCommit: "c".repeat(40) });
    const mergeCall = calls().find((a) => a[0] === "pr" && a[1] === "merge");
    expect(mergeCall).toEqual(["pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", sha]);
    expect(calls().flat()).not.toContain("--auto");
  });

  test("--author-email is passed to the merge", () => {
    const { run, calls, head: sha } = fake();
    run(...merge, "--author-email", "1+me@users.noreply.github.com");
    expect(calls().find((a) => a[1] === "merge")).toEqual([
      "pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", sha, "--author-email", "1+me@users.noreply.github.com",
    ]);
  });

  test("refuses without merging when the verdict is missing", () => {
    const { run, calls, head: sha } = fake({ statuses: [] });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons).toEqual([`no ${CONTEXT} status on ${sha}`]);
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("--dry-run reports would-merge and does not merge", () => {
    const { run, calls, head: sha } = fake();
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("would-merge");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("a merge GitHub did not confirm is reported as unconfirmed", () => {
    const { run } = fake({ after: { state: "OPEN", mergeCommit: null } });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("unconfirmed");
    expect(r.json.reasons[0]).toContain("merge not confirmed: state OPEN");
  });

  test("a gh failure after the merge request is unconfirmed, not refused", () => {
    const { run, head: sha } = fake({ fail: "state,mergeCommit,headRefOid" });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("unconfirmed");
    expect(r.json.reasons[0]).toContain("merge requested, then gh failed");
  });

  test("a gh failure while reading facts refuses instead of merging", () => {
    const { run, calls, head: sha } = fake({ fail: "check-runs" });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.reasons[0]).toContain("gh failed:");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("the floor guard refuses a PR that adds a suppression comment, and leaves no worktree behind", () => {
    // Built in pieces, so this file does not itself add a suppression comment.
    const { run, calls, work } = fake({ change: { path: "src/app.js", text: `// @ts-${"ignore"}\nexport const answer = 42;\n` } });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/app.js"))).toBe(true);
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
    expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("the floor guard runs only in a checkout of the PR's repository", () => {
    const { run, calls } = fake();
    const r = run("merge", "--repo", "x/y", "--pr", "7", "--sha", SHA);
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("floor guard could not run: origin of");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("--dry-run runs the floor too", () => {
    const { run } = fake({ change: { path: "src/app.js", text: `export function later() { throw new Error("Not ${"implemented"}"); }\n` } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[unfinished-work]"))).toBe(true);
  });

  test("Markdown that describes the floor's patterns passes, and CONSTRAINTS.md still counts", () => {
    const docs = fake({ change: { path: "notes.md", text: `Never add @ts-${"ignore"} or leave a ${"TO"}DO.\n` } });
    expect(docs.run(...merge, "--dry-run").json.kind).toBe("would-merge");
    const bar = fake({ change: { path: "CONSTRAINTS.md", text: `# Constraints\n\n## Exceptions\n\n| ID | Rule |\n|---|---|\n| W1 | no-${"explicit"}-any |\n` } });
    const r = bar.run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[new-exception] CONSTRAINTS.md"))).toBe(true);
  });

  const TEST = "src/app.test.js";
  const ASSERT = `test("adds", () => { ${"expect"}(1 + 1).toBe(2); });\n`;

  test("a PR's own .gitattributes cannot hide a finding", () => {
    const { run } = fake({ change: { path: ".gitattributes", text: "* -diff\n" }, setup: { base: { [TEST]: ASSERT }, files: { [TEST]: `${ASSERT}test.${"skip"}("later", () => {});\n` } } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[test-made-easier]"))).toBe(true);
  });

  test("renaming a test file away counts as deleting it", () => {
    const { run } = fake({ change: { path: "src/note.js", text: "export {};\n" }, setup: { base: { [TEST]: ASSERT }, move: [TEST, "src/app.check.js"] } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[test-deleted] src/app.test.js"))).toBe(true);
  });

  test("a colon in a code file's name does not make its finding look like Markdown", () => {
    const { run } = fake({ change: { path: "src/x.md:y.js", text: `// eslint-${"disable"}\nexport {};\n` } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/x.md:y.js"))).toBe(true);
  });

  test("the checkout's own git config cannot switch the floor off", () => {
    const { run, work } = fake({ setup: { base: { [TEST]: ASSERT }, files: { [TEST]: `${ASSERT}test.${"skip"}("later", () => {});\n` } } });
    git(work, "config", "diff.external", "true");
    git(work, "config", "color.ui", "always");
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[test-made-easier]"))).toBe(true);
  });

  test("a guard that cannot run refuses: no PR ref to fetch", () => {
    const { run } = fake({ setup: { pullRef: false } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("floor guard could not run");
  });

  test("the gate leaves the user's other worktrees alone, even one whose folder is missing for now", () => {
    const { run, work } = fake();
    const other = join(work, "..", "other");
    git(work, "worktree", "add", "-q", "-b", "side", other);
    const away = `${other}-away`;
    renameSync(other, away);
    run(...merge, "--dry-run");
    renameSync(away, other);
    expect(git(other, "status", "--short")).toBe("");
  });

  test("verdict writes the potluck/verdict status on that exact head", () => {
    const { run, calls, head: sha } = fake();
    const r = run("verdict", "--repo", "o/r", "--sha", sha, "--state", "pass");
    expect(r.json).toEqual({ kind: "recorded", repo: "o/r", sha, state: "success" });
    const post = calls()[0];
    expect(post.slice(0, 4)).toEqual(["api", "--method", "POST", `repos/o/r/statuses/${sha}`]);
    expect(post).toContain(`context=${CONTEXT}`);
    expect(post).toContain("state=success");
  });

  test.each([
    [["merge", "--repo", "o/r", "--pr", "7", "--sha", "abc"], "--sha must be a full"],
    [["merge", "--repo", "nope", "--pr", "7", "--sha", sha], "--repo must be owner/repo"],
    [["verdict", "--repo", "o/r", "--sha", sha, "--state", "maybe"], "--state must be pass or fail"],
    [["land", "--repo", "o/r", "--sha", sha], 'unknown command "land"'],
  ])("usage error %#", (args, message) => {
    const { run } = fake();
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });
});
