// potluck: the deterministic merge gate (A8) in
// plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs. The decision is a
// pure function; the CLI runs against a fake `gh` on PATH that answers from a
// fixture and records every call, so no test touches GitHub.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTEXT, refusals } from "../plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs";

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

describe("merge-gate CLI against a fake gh", () => {
  const dirs = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  // The fake answers `pr view` with `view` (then `after` once a merge ran),
  // the statuses and check-runs endpoints with one page each, and records argv.
  function fake({ view = open, after = { state: "MERGED", headRefOid: sha, mergeCommit: { oid: "c".repeat(40) } }, statuses = [pass], runs = [ci], fail = "" } = {}) {
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
      const r = spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { run, calls };
  }
  const merge = ["merge", "--repo", "o/r", "--pr", "7", "--sha", sha];

  test("merges with --match-head-commit and never --auto, then confirms the merge", () => {
    const { run, calls } = fake();
    const r = run(...merge);
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ kind: "merged", repo: "o/r", pr: 7, sha, mergeCommit: "c".repeat(40) });
    const mergeCall = calls().find((a) => a[0] === "pr" && a[1] === "merge");
    expect(mergeCall).toEqual(["pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", sha]);
    expect(calls().flat()).not.toContain("--auto");
  });

  test("refuses without merging when the verdict is missing", () => {
    const { run, calls } = fake({ statuses: [] });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons).toEqual([`no ${CONTEXT} status on ${sha}`]);
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("--dry-run reports would-merge and does not merge", () => {
    const { run, calls } = fake();
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("would-merge");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("a merge GitHub did not confirm is reported as refused", () => {
    const { run } = fake({ after: { state: "OPEN", headRefOid: sha, mergeCommit: null } });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.reasons[0]).toContain("merge not confirmed: state OPEN");
  });

  test("a gh failure while reading facts refuses instead of merging", () => {
    const { run, calls } = fake({ fail: "check-runs" });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.reasons[0]).toContain("gh failed:");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("verdict writes the potluck/verdict status on that exact head", () => {
    const { run, calls } = fake();
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
