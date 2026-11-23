// potluck: the deterministic merge gate (A8) in
// plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs. The decision is a
// pure function; the CLI runs against a fake `gh` on PATH that answers from a
// fixture and records every call, so no test touches GitHub.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTEXT, FLOOR_GUARD, OVERVIEW, guardSource, refusals } from "../plugins/pstack/skills/poteto-mode/scripts/merge-gate.mjs";

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
    mkdirSync(join(work, change.path, ".."), { recursive: true });
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
    const runAt = (cwd, ...args) => {
      const filled = args.map((a) => (a === SHA ? head : a));
      const r = spawnSync("node", [script, ...filled], { cwd, encoding: "utf8", env: { ...gitEnv, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    const run = (...args) => runAt(repoDir.work, ...args);
    const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const setView = (over) => {
      const f = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
      f.view = { ...f.view, ...over };
      writeFileSync(join(dir, "fixture.json"), JSON.stringify(f));
    };
    return { run, runAt, calls, head, work: repoDir.work, setView };
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

  // Step 3's template, read from the skill, so this test follows the template the skill hands out.
  const TEMPLATE = readFileSync(join(import.meta.dir, "../plugins/pstack/skills/constraint-driven-development/SKILL.md"), "utf8")
    .match(/^### Step 3[\s\S]*?^```markdown\n([\s\S]*?)^```$/m)[1];

  test("the skill's own CONSTRAINTS.md template passes the floor, and its example exception still counts", () => {
    const own = fake({ change: { path: "CONSTRAINTS.md", text: TEMPLATE.replace(/^\| W1 \|.*\n/m, "") } });
    expect(own.run(...merge, "--dry-run").json.kind).toBe("would-merge");
    const verbatim = fake({ change: { path: "CONSTRAINTS.md", text: TEMPLATE } }).run(...merge, "--dry-run");
    expect(verbatim.json.kind).toBe("refused");
    expect(verbatim.json.reasons).toHaveLength(1);
    expect(verbatim.json.reasons[0]).toStartWith("floor: [new-exception] CONSTRAINTS.md: | W1 |");
  });

  test("a rule written with a full-width colon keeps its key, so rewording it is not a removal", () => {
    const rule = (text) => `# 约束\n\n## 底线\n\n- 测试覆盖率：${text}\n`;
    const edit = (from, to) => fake({ change: { path: "CONSTRAINTS.md", text: rule(to) }, setup: { base: { "CONSTRAINTS.md": rule(from) } } }).run(...merge, "--dry-run");
    expect(edit("改动的行至少 80%", "每次改动的行至少 80%").json.kind).toBe("would-merge");
    const loosened = edit(">= 80%", ">= 70%");
    expect(loosened.json.kind).toBe("refused");
    expect(loosened.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: - 测试覆盖率：>= 80%  ->  - 测试覆盖率：>= 70%"]);
  });

  test("two rules that share a key each need a counterpart, so deleting one while editing the other is a removal", () => {
    const bullet = "- Coverage: changed lines at least 80% covered\n";
    const table = "| Dimension | Rule | Checked by |\n|---|---|---|\n| Coverage | Changed lines ≥ 80% covered | `vitest run --coverage` |\n";
    const before = `# Constraints\n\n## Floor\n\n${bullet}\n## Enforced with numbers\n\n${table}`;
    const after = before.replace(bullet, "").replace("`vitest run --coverage` |", "`vitest run --coverage` + git diff |");
    const r = fake({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons).toEqual([`floor: [rule-removed] CONSTRAINTS.md: ${bullet.trim()}`]);
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

  test("a PR's .gitattributes cannot re-encode a test file on checkout to hide it", () => {
    // The file is written as UTF-16LE with a BOM, as the attribute says, so git
    // stores it as UTF-8 and a checkout under the PR's attributes would write
    // it back as UTF-16, which the guard reads as binary.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${ASSERT}test.${"skip"}("later", () => {});\n`, "utf16le")]);
    const { run } = fake({ change: { path: ".gitattributes", text: "*.test.js working-tree-encoding=UTF-16LE-BOM\n" }, setup: { base: { [TEST]: ASSERT }, files: { [TEST]: utf16 } } });
    const r = run(...merge, "--dry-run");
    // The fixture commits the attribute and the file together, so git converts
    // the blob on add; either way the floor must see the change and refuse.
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.every((l) => l.startsWith("floor: ["))).toBe(true);
  });

  test("CI that never started on a repository with workflows refuses", () => {
    const { run } = fake({ runs: [], setup: { base: { ".github/workflows/ci.yml": "on: pull_request\n" } } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("no CI result on");
  });

  test("a PR that deletes the base's CI cannot merge without a CI result", () => {
    const { run } = fake({ runs: [], setup: { base: { ".github/workflows/ci.yml": "on: pull_request\n" }, remove: [".github/workflows/ci.yml"] } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("no CI result on");
  });

  test("deleting a committed binary file passes the binary check", () => {
    const { run } = fake({ setup: { base: { ".DS_Store": Buffer.from([0, 1, 2, 3, 0]) }, remove: [".DS_Store"] } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  const FEATURE = "# Votes\n\nLets a club vote.\n\nFor: book clubs.\n\n## Done when\n\n- [ ] A member can vote once.\n";

  test("a PR that changes a feature file without regenerating the overview refuses", () => {
    const { run } = fake({ change: { path: "docs/features/votes.md", text: FEATURE } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("overview: docs/overview.md is stale or missing");
  });

  test("a project with only an ADR merges without an overview", () => {
    const { run } = fake({ change: { path: "docs/adr/0001-use-postgres.md", text: "# Use Postgres\n" } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("the overview is checked even when the floor's only findings are in Markdown", () => {
    const { run } = fake({ change: { path: "docs/features/votes.md", text: FEATURE }, setup: { files: { "notes.md": `Never add @ts-${"ignore"}.\n` } } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("overview: docs/overview.md is stale or missing");
  });

  test("a PR that ticks a Done when item without proof refuses", () => {
    const { run } = fake({ change: { path: "docs/features/votes.md", text: FEATURE.replace("- [ ]", "- [x]") } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("ticked without proof");
  });

  test("a PR with its overview regenerated passes", () => {
    const root = mkdtempSync(join(tmpdir(), "potluck-gate-ov-"));
    dirs.push(root);
    mkdirSync(join(root, "docs/features"), { recursive: true });
    writeFileSync(join(root, "docs/features/votes.md"), FEATURE);
    spawnSync("node", [OVERVIEW, "--root", root, "--write"]);
    const overview = readFileSync(join(root, "docs/overview.md"), "utf8");
    const { run } = fake({ change: { path: "docs/features/votes.md", text: FEATURE }, setup: { files: { "docs/overview.md": overview } } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a NUL byte in an extension-less script is refused too", () => {
    const { run } = fake({ change: { path: "bin/run", text: `#!/usr/bin/env node\n/*\0*/\n// eslint-${"disable"}\n` } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("[binary-source] bin/run");
  });

  test("a binary image passes the binary check", () => {
    const { run } = fake({ change: { path: "logo.png", text: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a shallow checkout still runs the floor", () => {
    const { runAt, work } = fake({ change: { path: "src/app.js", text: `// eslint-${"disable"}\nexport {};\n` } });
    const shallowDir = join(work, "..", "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${join(work, "..", "o", "r.git")}`, shallowDir], { env: gitEnv });
    const r = runAt(shallowDir, ...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/app.js"))).toBe(true);
  });

  test("a NUL byte that makes a source file binary is refused, since the floor cannot read it", () => {
    const { run } = fake({ setup: { base: { [TEST]: ASSERT }, files: { [TEST]: `/*\0*/\n${ASSERT}test.${"skip"}("later", () => {});\n` } } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("[binary-source] src/app.test.js");
  });

  test("a guard that exits 2 refuses: no merge base with the PR's base", () => {
    const { run, work, setView } = fake();
    git(work, "switch", "-q", "--orphan", "lonely");
    writeFileSync(join(work, "lonely.txt"), "x\n");
    git(work, "add", "lonely.txt");
    git(work, "commit", "-q", "-m", "lonely");
    const lonely = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "main");
    setView({ baseRefOid: lonely });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("floor guard could not run");
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
