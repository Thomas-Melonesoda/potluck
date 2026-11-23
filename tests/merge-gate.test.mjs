// potluck: the deterministic merge gate (S3-A8) in
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

// Stage 5 issue 1: widening what the floor leaves unchecked loosens it, so the
// list is pinned here and each type on it must be named in the guard's register entry.
test("only plain .md goes unchecked, and the register entry names each unchecked type", () => {
  const list = guardSource().match(/^const UNCHECKED = (\[.*\]);$/m);
  const unchecked = list && JSON.parse(list[1].replaceAll("'", '"'));
  expect(unchecked).toEqual([".md"]);
  const forks = JSON.parse(readFileSync(join(import.meta.dir, "../tools/forks.json"), "utf8"));
  const { why } = forks["constraint-driven-development"]["plugins/pstack/skills/constraint-driven-development/references/floor-guard.md"];
  for (const type of unchecked) expect(why).toContain(`\`${type}\``);
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
  function checkout(change = { path: "src/app.js", text: "export const answer = 42;\n" }, { base: baseFiles = {}, files = {}, remove = [], move = null, pullRef = true, message = "change" } = {}) {
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
    git(work, "commit", "-q", "-m", message);
    const head = git(work, "rev-parse", "HEAD");
    if (pullRef) git(work, "push", "-q", "origin", "HEAD:refs/pull/7/head");
    else git(work, "push", "-q", "origin", "HEAD:refs/heads/feature");
    git(work, "switch", "-q", "main");
    return { work, base, head };
  }

  // The fake answers `pr view` with `view` (then `after` once a merge ran),
  // the statuses and check-runs endpoints with one page each, and records argv.
  // The gate runs in a fixture checkout, so the floor guard has a real PR to read,
  // and with its own HOME, holding the user's gates file when `gates` is given.
  function fake({ view: viewOver = {}, after: afterOver, statuses = [pass], runs = [ci], suites = [], fail = "", change, setup = {}, gates } = {}) {
    const repoDir = checkout(change, setup);
    const head = repoDir.head;
    const view = { ...open, headRefOid: head, baseRefOid: repoDir.base, ...viewOver };
    const after = { state: "MERGED", headRefOid: head, mergeCommit: { oid: "c".repeat(40) }, ...afterOver };
    const dir = mkdtempSync(join(tmpdir(), "potluck-gate-"));
    dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "home/.potluck"), { recursive: true });
    if (gates !== undefined) writeFileSync(join(dir, "home/.potluck/gates.json"), typeof gates === "string" ? gates : JSON.stringify(gates));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ view, after, statuses, runs, suites, fail }));
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
else if (line.includes("/check-suites")) process.stdout.write(JSON.stringify([{ check_suites: f.suites }]));
else if (line.includes("POST")) process.stdout.write("{}");
`,
      { mode: 0o755 },
    );
    const runAt = (cwd, ...args) => {
      const filled = args.map((a) => (a === SHA ? head : a));
      const r = spawnSync("node", [script, ...filled], { cwd, encoding: "utf8", env: { ...gitEnv, HOME: join(dir, "home"), PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    const run = (...args) => runAt(repoDir.work, ...args);
    const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const setView = (over) => {
      const f = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
      f.view = { ...f.view, ...over };
      writeFileSync(join(dir, "fixture.json"), JSON.stringify(f));
    };
    // Lists a status first, the way GitHub lists the newest.
    const addStatus = (status) => {
      const f = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
      f.statuses = [status, ...f.statuses];
      writeFileSync(join(dir, "fixture.json"), JSON.stringify(f));
    };
    return { run, runAt, calls, head, work: repoDir.work, setView, addStatus, dir };
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
    const bar = fake({ change: { path: "CONSTRAINTS.md", text: `# Constraints\n\n## Exceptions\n\n| ID | Rule |\n|---|---|\n| W1 | no-${"explicit"}-any |\n` }, setup: { base: { "CONSTRAINTS.md": "# Constraints\n" } } });
    const r = bar.run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons.some((l) => l.includes("[new-exception] CONSTRAINTS.md"))).toBe(true);
  }, 15_000);

  const TEMPLATE = readFileSync(join(import.meta.dir, "../plugins/pstack/skills/constraint-driven-development/SKILL.md"), "utf8")
    .match(/^### Step 3[\s\S]*?^```markdown\n([\s\S]*?)^```$/m)[1];

  test("the skill's own CONSTRAINTS.md template passes the floor", () => {
    const { run } = fake({ change: { path: "CONSTRAINTS.md", text: TEMPLATE.replace(/^\| W1 \|.*\n/m, "") } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("over a CONSTRAINTS.md already in place, the template's example exception row is its only floor finding", () => {
    const r = fake({ change: { path: "CONSTRAINTS.md", text: TEMPLATE }, setup: { base: { "CONSTRAINTS.md": "# Constraints\n" } } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons).toHaveLength(1);
    expect(r.json.reasons[0]).toStartWith("floor: [new-exception] CONSTRAINTS.md: | W1 |");
  });

  const rule = (text) => `# 约束\n\n## 底线\n\n- 测试覆盖率：${text}\n`;
  const editRule = (from, to) => fake({ change: { path: "CONSTRAINTS.md", text: rule(to) }, setup: { base: { "CONSTRAINTS.md": rule(from) } } }).run(...merge, "--dry-run");

  test("a rule written with a full-width colon keeps its key, so rewording it is not a removal", () => {
    expect(editRule("改动的行至少 80%", "每次改动的行至少 80%").json.kind).toBe("would-merge");
  });

  test("a loosened threshold in a rule written with a full-width colon reads as loosened", () => {
    const r = editRule(">= 80%", ">= 70%");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: - 测试覆盖率：>= 80%  ->  - 测试覆盖率：>= 70%"]);
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

  // Stage 5 issue 2: Chinese entries read their direction words as well as their colon.
  test("a Chinese minimum lowered reads as loosened", () => {
    expect(editRule("改动的行至少 80%", "改动的行至少 70%").json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: - 测试覆盖率：改动的行至少 80%  ->  - 测试覆盖率：改动的行至少 70%"]);
  });

  test("a raised Chinese minimum is still reported, as main reports any change to a Chinese number", () => {
    expect(editRule("改动的行不低于 80%", "改动的行不低于 90%").json.reasons[0]).toStartWith("floor: [threshold-changed] CONSTRAINTS.md:");
  });

  test("a Chinese minimum turned into a maximum is stopped", () => {
    const r = editRule("改动的行至少 80%", "改动的行至多 80%");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toStartWith("floor: [threshold-removed] CONSTRAINTS.md:");
  });

  test("a Chinese ratchet row that falls reads as loosened", () => {
    const table = (n) => `# 约束\n\n## 已测量\n\n| 指标 | 今天 | 方向 |\n|---|---|---|\n| 项目覆盖率 | ${n}% | 不得下降 |\n`;
    const r = fake({ change: { path: "CONSTRAINTS.md", text: table("60") }, setup: { base: { "CONSTRAINTS.md": table("62.4") } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: | 项目覆盖率 | 62.4% | 不得下降 |  ->  | 项目覆盖率 | 60% | 不得下降 |"]);
  });

  test("a Chinese word that runs on past its number, or an ambiguous 最高, gives no direction either", () => {
    const bar = (a, b, c, d, e) => `# 约束\n\n- 行覆盖率：${a}% 以下 3 个目录除外\n- 历史覆盖率：历史最高 ${b}%，不得下降\n- 项目覆盖率：不得下降到 ${c}% 以下\n\n| 指标 | 门槛 | 说明 |\n|---|---|---|\n| 函数覆盖率 | ${d}% | 以下 3 个目录除外：src/a、src/b |\n| 包大小 | ${e} KB | 以上 2 条适用于所有包 |\n`;
    const r = fake({ change: { path: "CONSTRAINTS.md", text: bar(60, 60, 60, 60, 500) }, setup: { base: { "CONSTRAINTS.md": bar(80, 80, 80, 80, 200) } } }).run(...merge, "--dry-run");
    expect(r.json.reasons.map((l) => l.split(/：|% \|| KB \|/)[0])).toEqual([
      "floor: [threshold-changed] CONSTRAINTS.md: - 行覆盖率",
      "floor: [threshold-changed] CONSTRAINTS.md: - 历史覆盖率",
      "floor: [threshold-loosened] CONSTRAINTS.md: - 项目覆盖率",
      "floor: [threshold-changed] CONSTRAINTS.md: | 函数覆盖率 | 80",
      "floor: [threshold-changed] CONSTRAINTS.md: | 包大小 | 200",
    ]);
  });

  test("a Chinese ceiling word before a number is read, and 以上 or 以下 after it gives no direction", () => {
    const bar = (a, b, c, d, e) => `# 约束\n\n- 包大小：不得增长到 ${a}KB 以上\n- 构建时间：不得增长到 ${b} min 以上\n- 产物大小：不得超过 ${c}KB 以上\n- 页面大小：不得增长到 ${d} KB 以上\n\n| 指标 | 门槛 | 说明 |\n|---|---|---|\n| 镜像大小 | ${e} KB | 以上，适用于所有包 |\n`;
    const r = fake({ change: { path: "CONSTRAINTS.md", text: bar(500, 30, 500, 150, 500) }, setup: { base: { "CONSTRAINTS.md": bar(200, 10, 200, 200, 200) } } }).run(...merge, "--dry-run");
    expect(r.json.reasons.map((l) => l.split(/：| KB \|/)[0])).toEqual([
      "floor: [threshold-loosened] CONSTRAINTS.md: - 包大小",
      "floor: [threshold-loosened] CONSTRAINTS.md: - 构建时间",
      "floor: [threshold-loosened] CONSTRAINTS.md: - 产物大小",
      "floor: [threshold-changed] CONSTRAINTS.md: - 页面大小",
      "floor: [threshold-changed] CONSTRAINTS.md: | 镜像大小 | 200",
    ]);
  });

  test("English words are read as main reads them, and Chinese words that disagree give no direction", () => {
    const bar = (a, b, c, d, e, f, g, h) => `# Constraints\n\n- Coverage: never below ${a}%, must not drop\n- Small files: files under ${b} KB must not drop\n- Modules: modules below ${c} lines must not drop\n\n| Metric | Bar | Direction |\n|---|---|---|\n| Line coverage | not under ${d}% | must not drop |\n| Branch coverage | fails if < ${e}% | must not drop |\n| Statement coverage | never below ${f}% | must not fall |\n| 覆盖率 | 不超过 ${g}% | 不得下降 |\n| 包大小 | 不低于 ${h} kB | 不得增长 |\n`;
    const r = fake({ change: { path: "CONSTRAINTS.md", text: bar(60, 1, 500, 60, 60, 60, 60, 300) }, setup: { base: { "CONSTRAINTS.md": bar(80, 2, 1000, 80, 80, 80, 80, 184) } } }).run(...merge, "--dry-run");
    expect(r.json.reasons.map((l) => l.match(/^floor: \[([a-z-]+)\]/)?.[1])).toEqual([...Array(6).fill("threshold-loosened"), "threshold-changed", "threshold-changed"]);
  });

  test("dropping the words around a number whose words disagree reads as removed, and 甚至少 is not 至少", () => {
    const before = "# Constraints\n\n- Coverage: never below 80%, must not drop\n- Lighthouse: fails below 90, must not drop\n- Small files: files under 2 KB must not drop\n- 覆盖率：不得下降，甚至少 1% 也不行\n\n| Metric | Bar | Direction |\n|---|---|---|\n| Line coverage | not under 80% | must not drop |\n| Branch coverage | fails if < 80% | must not drop |\n| Statement coverage | never below 80% | must not fall |\n";
    const after = before.replace("never below 80%, must not drop", "80% target").replace("fails below 90, must not drop", "90 is the goal").replace("files under 2 KB must not drop", "2 KB files may drop").replace("甚至少 1%", "甚至少 5%")
      .replace("not under 80% | must not drop", "80% | advisory").replace("fails if < 80% | must not drop", "80% | informational").replace("never below 80% | must not fall", "80% | may fall");
    const r = fake({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run(...merge, "--dry-run");
    expect(r.json.reasons.map((l) => l.match(/^floor: \[([a-z-]+)\]/)?.[1])).toEqual(["threshold-removed", "threshold-removed", "threshold-removed", "threshold-changed", "threshold-removed", "threshold-removed", "threshold-removed"]);
  });

  test("a lower bar added in front of one whose words disagree is still a loosening", () => {
    const before = "# Constraints\n\n- Coverage: at least 80%\n- Lighthouse: at least 90\n\n| Metric | Bar | Direction |\n|---|---|---|\n| Line coverage | at least 80% | |\n| 覆盖率 | 不超过 80% | 不得下降 |\n";
    const after = before.replace("- Coverage: at least 80%", "- Coverage: never below 60%, must not drop; at least 80% for new code").replace("- Lighthouse: at least 90", "- Lighthouse: fails below 70, must not drop; at least 90 on the home page")
      .replace("| Line coverage | at least 80% | |", "| Line coverage | fails if < 60%, must not drop; at least 80% for new code | |").replace("| 不超过 80% |", "| 至少 60%，不超过 80% |");
    const r = fake({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run(...merge, "--dry-run");
    expect(r.json.reasons.map((l) => l.match(/^floor: \[([a-z-]+)\]/)?.[1])).toEqual(["threshold-loosened", "threshold-loosened", "threshold-loosened", "threshold-changed"]);
  });

  test("a branch cut before main gained its first CONSTRAINTS.md cannot add an exception as if it set the bar", () => {
    const gate = fake({ change: { path: "packages/a/CONSTRAINTS.md", text: "# Constraints\n\n| ID | Rule |\n|---|---|\n| W1 | no-explicit-any |\n" } });
    writeFileSync(join(gate.work, "CONSTRAINTS.md"), "# Constraints\n\n- Coverage: at least 80%\n");
    git(gate.work, "add", "CONSTRAINTS.md");
    git(gate.work, "commit", "-q", "-m", "bar");
    git(gate.work, "push", "-q", "origin", "main");
    gate.setView({ baseRefOid: git(gate.work, "rev-parse", "HEAD") });
    expect(gate.run(...merge, "--dry-run").json.reasons).toEqual(["floor: [new-exception] packages/a/CONSTRAINTS.md: | W1 | no-explicit-any |"]);
  });

  test("a test command in plain .md under ci_scripts/ is not a CI step", () => {
    const r = fake({ change: { path: "ci_scripts/README.md", text: "Run the suite first.\n" }, setup: { base: { "ci_scripts/README.md": "Run npm test first.\n" } } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("would-merge");
  });

  test("a path with a space keeps its name, so plain .md stays unchecked and a Swift test there is still a test", () => {
    const swift = "My App Tests/AppTests.swift";
    const r = fake({ change: { path: "docs/Meeting notes.md", text: `Leave a ${"TO"}DO here.\n` }, setup: { base: { [swift]: XCTEST }, remove: [swift] } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [test-deleted] ${swift}: file deleted`]);
  });

  test("Chinese words that only sit near a number give it no direction, so a change to it is still reported", () => {
    const bar = (a, b, c, d, e) => `# 约束\n\n- 包大小：${a}KB，以上规则适用于所有包\n- 行覆盖率：${b}%（以下目录除外：src/legacy）\n- 测试覆盖率：${c}%，三个月以内提高到 90%\n- 分支覆盖率：低于 ${d}% 即失败\n\n| 指标 | 门槛 | 说明 |\n|---|---|---|\n| 函数覆盖率 | ${e}% | 以下目录除外：src/legacy |\n`;
    const r = fake({ change: { path: "CONSTRAINTS.md", text: bar(500, 60, 60, 60, 60) }, setup: { base: { "CONSTRAINTS.md": bar(200, 80, 80, 80, 80) } } }).run(...merge, "--dry-run");
    expect(r.json.reasons.map((l) => l.split("：")[0])).toEqual([
      "floor: [threshold-changed] CONSTRAINTS.md: - 包大小",
      "floor: [threshold-changed] CONSTRAINTS.md: - 行覆盖率",
      "floor: [threshold-changed] CONSTRAINTS.md: - 测试覆盖率",
      "floor: [threshold-changed] CONSTRAINTS.md: - 分支覆盖率",
      "floor: [threshold-changed] CONSTRAINTS.md: | 函数覆盖率 | 80% | 以下目录除外",
    ]);
  });

  // Stage 5 issue 3: a rule's name says which line it is, so two rules may not share one.
  test("two rules with one name are refused, whichever colon each uses", () => {
    const text = "# 约束\n\n## 底线\n\n- 覆盖率：改动的行至少 80%\n- 覆盖率: 项目覆盖率不得下降\n";
    const r = fake({ change: { path: "CONSTRAINTS.md", text } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual(['floor: [duplicate-rule] CONSTRAINTS.md: "覆盖率" names 2 rules (lines 5, 6); rule names must be unique']);
  });

  test("a table row that repeats a bullet's name is refused", () => {
    const before = "# Constraints\n\n## Floor\n\n- Coverage: changed lines at least 80% covered\n";
    const after = `${before}\n## Enforced\n\n| Dimension | Rule |\n|---|---|\n| Coverage | Changed lines ≥ 80% covered |\n`;
    const r = fake({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual(['floor: [duplicate-rule] CONSTRAINTS.md: "Coverage" names 2 rules (lines 5, 11); rule names must be unique']);
  });

  test("tables that share a header and a separator do not repeat a rule", () => {
    const text = "# Constraints\n\n## Fast\n\n| Rule | Why |\n|---|---|\n| Types | zero errors |\n\n## Slow\n\n| Rule | Why |\n|---|---|\n| Audit | nothing high |\n";
    expect(fake({ change: { path: "CONSTRAINTS.md", text } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("nested bullets and a fenced example do not repeat a rule", () => {
    const text = "# Constraints\n\n- Coverage: at least 80%\n  - Tool: vitest\n- Lint: zero errors\n  - Tool: biome\n\n```markdown\n- Coverage: an example\n```\n";
    expect(fake({ change: { path: "CONSTRAINTS.md", text } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a repeated name in a CONSTRAINTS.md the change leaves alone does not block it", () => {
    const text = "# Constraints\n\n- Coverage: at least 80%\n- Coverage: must not fall\n";
    expect(fake({ setup: { base: { "CONSTRAINTS.md": text } } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  // Stage 5 issue 7: Swift tests, and the CI step that runs the tests.
  const SWIFT = "Tests/AppTests/AppTests.swift";
  const XCTEST = "import XCTest\n\nfinal class AppTests: XCTestCase {\n  func testAnswer() {\n    XCTAssertEqual(answer, 42)\n  }\n}\n";

  test("deleting a Swift test file is stopped", () => {
    const r = fake({ setup: { base: { [SWIFT]: XCTEST }, remove: [SWIFT] } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [test-deleted] ${SWIFT}: file deleted`]);
  });

  test("an XCTSkip added to a Swift test is stopped", () => {
    const skipped = XCTEST.replace("  func testAnswer() {\n", `  func testAnswer() throws {\n    throw XCT${"Skip"}("later")\n`);
    const r = fake({ setup: { base: { [SWIFT]: XCTEST }, files: { [SWIFT]: skipped } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [test-made-easier] ${SWIFT}: throw XCT${"Skip"}("later")`]);
  });

  test("XCTSkip named in prose is not a skip", () => {
    expect(fake({ change: { path: "src/notes.json", text: `{ "why": "XCT${"Skip"} counts as a skip" }\n` } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("an XCTAssert removed from a Swift test that stayed is stopped", () => {
    const r = fake({ setup: { base: { [SWIFT]: XCTEST }, files: { [SWIFT]: XCTEST.replace("    XCTAssertEqual(answer, 42)\n", "") } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [assertion-removed] ${SWIFT}: XCTAssertEqual(answer, 42)`]);
  });

  const CI = ".github/workflows/ci.yml";
  const WORKFLOW = (steps) => `on: pull_request\njobs:\n  test:\n    runs-on: macos-latest\n    steps:\n      - uses: actions/checkout@v4\n${steps}`;

  test("a test step removed from CI configuration is stopped", () => {
    const r = fake({ change: { path: CI, text: WORKFLOW("") }, setup: { base: { [CI]: WORKFLOW("      - run: swift test\n") } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${CI}: - run: swift test`]);
  });

  test("a CI test step commented out is stopped", () => {
    const r = fake({ change: { path: CI, text: WORKFLOW("      # - run: swift test\n") }, setup: { base: { [CI]: WORKFLOW("      - run: swift test\n") } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${CI}: - run: swift test`]);
  });

  test("a CI test step moved to another workflow passes", () => {
    const moved = { base: { [CI]: WORKFLOW("      - run: swift test --parallel\n") }, files: { ".github/workflows/test.yml": WORKFLOW("      - run: swift test\n") } };
    expect(fake({ change: { path: CI, text: WORKFLOW("") }, setup: moved }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("CI edits that keep the tests running pass", () => {
    const step = (name, run) => WORKFLOW(`      - name: ${name}\n        run: ${run}\n`);
    const setup = { base: { [CI]: step("Run npm test", "npm test"), ".github/workflows/README.md": "Run bun test locally first.\n" }, files: { ".github/workflows/README.md": "Run the suite locally first.\n" } };
    expect(fake({ change: { path: CI, text: step("Unit tests", "pnpm run test:ci") }, setup }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a JS test step swapped for another JS test runner passes", () => {
    const steps = (a, b) => WORKFLOW(`      - run: ${a}\n      - run: ${b}\n`);
    expect(fake({ change: { path: CI, text: steps("npx vitest run", "pnpm -r test") }, setup: { base: { [CI]: steps("npm test", "pnpm test") } } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a test step removed from a composite action, after an install on its line, is stopped", () => {
    const ACTION = ".github/actions/check/action.yml";
    const action = (run) => `runs:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`;
    const r = fake({ change: { path: ACTION, text: action("pip install pytest") }, setup: { base: { [ACTION]: action("pip install pytest && pytest") } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${ACTION}: - run: pip install pytest && pytest`]);
  });

  // Stage 5 issue 1: every file that runs is read for the forbidden forms; only plain .md is not.
  const NOTEBOOK = (code) => `${JSON.stringify({ cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [code] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
  test("a forbidden form is stopped in every file that runs, and passes only in plain .md", () => {
    const noqa = `# no${"qa"}`;
    const files = {
      "notes.md": `Never write ${noqa} here.\n`,
      "notes.markdown": `Never write ${noqa} here.\n`,
      "notes.txt": `Never write ${noqa} here.\n`,
      "docs/guide.rst": `Never write ${noqa} here.\n`,
      "docs/page.mdx": `{/* @ts-${"ignore"} */}\nexport const meta = {};\n`,
      "analysis.ipynb": NOTEBOOK(`import os  ${noqa}\n`),
      ".github/workflows/lint.yml": `on: pull_request\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: semgrep scan  # no${"semgrep"}\n`,
      Makefile: `lint:\n\truff check .  ${noqa}\n`,
      "src/tool.py": `import os  ${noqa}\n`,
    };
    const r = fake({ setup: { files } }).run(...merge, "--dry-run");
    const flagged = r.json.reasons.map((l) => l.match(/^floor: \[silenced-checker\] (.+?): /)?.[1]).filter(Boolean);
    expect(flagged.sort()).toEqual(Object.keys(files).filter((f) => f !== "notes.md").sort());
  });

  test("CONSTRAINTS.md is plain Markdown, yet a lowered number in it is stopped", () => {
    const before = "# Constraints\n\n- Coverage: changed lines at least 80% covered\n";
    const r = fake({ change: { path: "CONSTRAINTS.md", text: before.replace("80%", "70%") }, setup: { base: { "CONSTRAINTS.md": before } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: - Coverage: changed lines at least 80% covered  ->  - Coverage: changed lines at least 70% covered"]);
  });

  // Build the lever (S3-B5): the floor counts as working only while both canaries hold.
  describe("floor canaries", () => {
    test("the skill's CONSTRAINTS.md template passes as written", () => {
      expect(fake({ change: { path: "CONSTRAINTS.md", text: TEMPLATE } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
    });

    test("a code file with a deliberate suppression is stopped", () => {
      const r = fake({ change: { path: "src/app.ts", text: `// @ts-${"ignore"}\nexport const answer: number = "42";\n` } }).run(...merge, "--dry-run");
      expect(r.json.reasons).toEqual([`floor: [silenced-checker] src/app.ts: // @ts-${"ignore"}`]);
    });
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

  // Stage 5 issue 17: a renamed test is only renamed, and a changed assertion waits for the root
  // agent's co-sign instead of refusing outright.
  const TWO = `test("adds", () => {\n  ${"expect"}(1 + 1).toBe(2);\n  ${"expect"}(2 + 2).toBe(4);\n});\n`;

  test("a test file renamed to another test name passes", () => {
    const { run } = fake({ setup: { base: { [TEST]: TWO }, move: [TEST, "src/sum.test.js"] } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a renamed test file's old skip does not read as new", () => {
    const { run } = fake({ setup: { base: { [TEST]: `${TWO}test.${"skip"}("later", () => {});\n` }, move: [TEST, "src/sum.test.js"] } });
    expect(run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  test("a test renamed with edits was not only renamed, so it reads as deleted, as on main", () => {
    const fewer = TWO.replace(`  ${"expect"}(2 + 2).toBe(4);\n`, "");
    const { run } = fake({ setup: { base: { [TEST]: TWO }, files: { [TEST]: fewer }, move: [TEST, "src/sum.test.js"] } });
    expect(run(...merge, "--dry-run").json.reasons).toEqual([`floor: [test-deleted] ${TEST}: file deleted`]);
  });

  test("a rename that changes the content, or drops one of two naming forms, reads as deleted", () => {
    const py = "pkg/test_math_test.py", rb = "test/test_user_test.rb", js = "src/a.test.js";
    const pyText = "def test_add():\n    assert 1 + 1 == 2\n", rbText = "require 'minitest/autorun'\n";
    const setup = { base: { [py]: pyText, [rb]: rbText, [js]: TWO }, files: { "pkg/math_test.py": pyText, "test/user_test.rb": rbText, "src/b.test.js": `${TWO}// renamed\n` }, remove: [py, rb, js] };
    expect(fake({ setup }).run(...merge, "--dry-run").json.reasons.sort()).toEqual([py, rb, js].map((f) => `floor: [test-deleted] ${f}: file deleted`).sort());
  });

  test("a CONSTRAINTS.md renamed away reads as every rule removed", () => {
    const bar = "# Constraints\n\n- Coverage: changed lines at least 80% covered\n";
    const { run } = fake({ setup: { base: { "CONSTRAINTS.md": bar }, move: ["CONSTRAINTS.md", "old-rules.md"] } });
    expect(run(...merge, "--dry-run").json.reasons).toEqual(["floor: [rule-removed] CONSTRAINTS.md: - Coverage: changed lines at least 80% covered"]);
  });

  test("an assertion moved within its test file waits for the co-sign too", () => {
    const swapped = `test("adds", () => {\n  ${"expect"}(2 + 2).toBe(4);\n  ${"expect"}(1 + 1).toBe(2);\n});\n`;
    const r = fake({ setup: { base: { [TEST]: TWO }, files: { [TEST]: swapped } } }).run(...merge, "--dry-run");
    expect(r.json.reasons[0]).toStartWith(`floor: [assertion-moved] ${TEST}: `);
    expect(r.json.reasons.at(-1)).toContain("needs the root agent's co-sign");
  });

  test("a test renamed to a name no runner picks up still reads as deleted", () => {
    const go = "mathx/add_test.go", py = "tests/test_math.py", pyText = "def test_add():\n    assert 1 + 1 == 2\n";
    const setup = { base: { [TEST]: TWO, [go]: "package mathx\n", [py]: pyText }, files: { "src/app.test.js.disabled": TWO, "mathx/testdata/add_test.go": "package mathx\n", "tests/latest_math.py": pyText }, remove: [TEST, go, py] };
    expect(fake({ setup }).run(...merge, "--dry-run").json.reasons.sort()).toEqual([go, TEST, py].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a test moved to another runner's naming, or into a folder runners skip, still reads as deleted", () => {
    const go = "mathx/add_test.go", py = "tests/test_math.py", js = "src/math.test.js", nm = "src/b.test.js";
    const goText = "package mathx\n", pyText = "def test_add():\n    assert 1 + 1 == 2\n", jsText = TWO.replace("adds", "math");
    const setup = { base: { [go]: goText, [py]: pyText, [js]: jsText, [nm]: TWO }, files: { "mathx/add.test.go": goText, "tests/math.test.py": pyText, "src/test_math.js": jsText, "node_modules/x/b.test.js": TWO }, remove: [go, py, js, nm] };
    expect(fake({ setup }).run(...merge, "--dry-run").json.reasons.sort()).toEqual([go, nm, js, py].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a test renamed in its folder to a name a runner's discovery skips reads as deleted", () => {
    const js = "src/a.test.mjs", swift = "Tests/AppTests/BTests.swift", rb = "test/a_test.rb", py = "pkg/test_math.py", py2 = "pkg/test_calc.py";
    const pyText = "def test_add():\n    assert 1 + 1 == 2\n";
    const base = { [js]: TWO, [swift]: "import XCTest\nfinal class BTests: XCTestCase {}\n", [rb]: "require 'minitest/autorun'\n", [py]: pyText, [py2]: pyText.replace("add", "sub") };
    const files = { "src/.a.test.mjs": base[js], "Tests/AppTests/.BTests.swift": base[swift], "test/.a_test.rb": base[rb], "pkg/test_math-old.py": base[py], "pkg/test_calc.old.py": base[py2] };
    const r = fake({ setup: { base, files, remove: Object.keys(base) } }).run(...merge, "--dry-run");
    expect(r.json.reasons.sort()).toEqual([swift, js, rb, py2, py].map((f) => `floor: [test-deleted] ${f}: file deleted`).sort());
  });

  test("a CI file with a test-like name moved out of the CI paths still reads as its test step removed", () => {
    const UNIT = ".github/workflows/unit_test.yml", step = WORKFLOW("      - run: npm test\n");
    const r = fake({ setup: { base: { [UNIT]: step }, files: { ".github/unit_test.yml": step }, remove: [UNIT] } }).run(...merge, "--dry-run");
    expect(r.json.reasons.sort()).toEqual([`floor: [ci-test-removed] ${UNIT}: - run: npm test`, `floor: [test-deleted] ${UNIT}: file deleted`]);
  });

  test("a test moved to another folder reads as deleted, as on main, since the folder decides what runs it", () => {
    const swift = "Tests/AppTests/MathTests.swift", rb = "test/test_user.rb";
    const swiftText = "import XCTest\nfinal class MathTests: XCTestCase {}\n", rbText = "require 'minitest/autorun'\n";
    const setup = { base: { [TEST]: TWO, [swift]: swiftText, [rb]: rbText }, files: { "src/__tests__/app.test.js": TWO, "Archive/MathTests.swift": swiftText, "lib/test_user.rb": rbText }, remove: [TEST, swift, rb] };
    expect(fake({ setup }).run(...merge, "--dry-run").json.reasons.sort()).toEqual([swift, TEST, rb].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a test renamed in its folder to a name Go skips, or to another naming form, reads as deleted", () => {
    const go = "mathx/add_test.go", sub = "mathx/sub_test.go", py = "tests/test_math.py", js = "src/math.test.js";
    const goText = "package mathx\n", pyText = "def test_add():\n    assert 1 + 1 == 2\n", jsText = TWO.replace("adds", "math");
    const setup = { base: { [go]: goText, [sub]: "package mathx // sub\n", [py]: pyText, [js]: jsText }, files: { "mathx/_add_test.go": goText, "mathx/sub_windows_test.go": "package mathx // sub\n", "tests/math_test.py": pyText, "src/math.spec.js": jsText }, remove: [go, sub, py, js] };
    expect(fake({ setup }).run(...merge, "--dry-run").json.reasons.sort()).toEqual([go, sub, js, py].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a CI file renamed out of the CI paths still reads as its test step removed", () => {
    const step = WORKFLOW("      - run: npm test\n");
    const r = fake({ setup: { base: { [CI]: step }, files: { ".github/ci.yml.off": step }, remove: [CI] } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${CI}: - run: npm test`]);
  });

  test("a Markdown file renamed into code brings its forbidden forms with it", () => {
    const text = `// @ts-${"ignore"}\nexport const x = 1;\n`;
    const r = fake({ setup: { base: { "docs/snippet.md": text }, files: { "src/snippet.ts": text }, remove: ["docs/snippet.md"] } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [silenced-checker] src/snippet.ts: // @ts-${"ignore"}`]);
  });

  test("an assertion commented out is removed, not changed", () => {
    const off = TWO.replace(`  ${"expect"}(2 + 2)`, `  // ${"expect"}(2 + 2)`);
    const r = fake({ setup: { base: { [TEST]: TWO }, files: { [TEST]: off } } }).run(...merge, "--dry-run");
    expect(r.json.reasons).toEqual([`floor: [assertion-removed] ${TEST}: ${"expect"}(2 + 2).toBe(4);`]);
  });

  const CHANGED = TWO.replace("toBe(4)", "toBe(5)");
  const changed = (over = {}) => fake({ ...over, setup: { base: { [TEST]: TWO }, files: { [TEST]: CHANGED } } });
  const FINDING = `floor: [assertion-changed] ${TEST}: ${"expect"}(2 + 2).toBe(4);  ->  ${"expect"}(2 + 2).toBe(5);`;
  const cosign = (gate) => ["cosign", "--repo", "o/r", "--pr", "7", "--sha", SHA, "--log", join(gate.dir, "decisions.tsv"), "--evidence", "verifier report: sums now round up"];

  test("a changed assertion is refused until the root agent co-signs it", () => {
    const r = changed().run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toBe(FINDING);
    expect(r.json.reasons[1]).toContain("needs the root agent's co-sign");
  });

  test("the co-sign is a status on the head and a row in the root agent's decision log, and it clears those findings", () => {
    const gate = changed();
    const r = gate.run(...cosign(gate));
    expect(r.json.kind).toBe("recorded");
    const post = gate.calls().find((a) => a.includes("POST"));
    expect(post).toContain("context=potluck/cosign");
    const description = post.find((a) => a.startsWith("description=")).slice("description=".length);
    expect(description).toBe(`co-signed 1 changed assertion ${r.json.cosign}`);
    const rows = readFileSync(join(gate.dir, "decisions.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t"));
    expect(rows[0]).toEqual(["ts", "phase", "decision", "why", "evidence", "result"]);
    expect(rows[1].slice(1)).toEqual(["cosign", `co-signed 1 changed assertion on o/r#7 at ${gate.head}`, "the verifier's evidence shows the behavior changed", "verifier report: sums now round up", `potluck/cosign ${r.json.cosign}`]);
    gate.addStatus({ context: "potluck/cosign", state: "success", description });
    expect(gate.run(...merge, "--dry-run").json.kind).toBe("would-merge");
  }, 20_000);

  test("a co-sign of other findings does not clear these", () => {
    const gate = changed();
    gate.addStatus({ context: "potluck/cosign", state: "success", description: "co-signed 1 changed assertion 0123456789abcdef" });
    expect(gate.run(...merge, "--dry-run").json.reasons[0]).toBe(FINDING);
  });

  test("a co-sign cannot clear a removed assertion", () => {
    const gate = fake({ setup: { base: { [TEST]: TWO }, files: { [TEST]: TWO.replace(`  ${"expect"}(2 + 2).toBe(4);\n`, "") } } });
    const r = gate.run(...cosign(gate));
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("clears only changed assertions");
    expect(gate.calls().some((a) => a.includes("POST"))).toBe(false);
  });

  test("a co-sign waits for the verifier's verdict", () => {
    const gate = changed({ statuses: [] });
    const r = gate.run(...cosign(gate));
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("no passing potluck/verdict");
  });

  test("a co-sign is not a CI result", () => {
    const gate = fake({ runs: [], setup: { base: { ".github/workflows/ci.yml": "on: pull_request\n" } } });
    gate.addStatus({ context: "potluck/cosign", state: "success", description: "co-signed 1 changed assertion 0123456789abcdef" });
    expect(gate.run(...merge, "--dry-run").json.reasons[0]).toContain("no CI result on");
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

  // A verdict GitHub has held for five minutes, so the head has been there at least that long.
  const aged = { ...pass, created_at: new Date(Date.now() - 5 * 60_000).toISOString() };
  const mainOnly = { ".github/workflows/ci.yml": "on:\n  push:\n    branches: [main]\n" };

  test("a head too new for CI to have started still waits for it", () => {
    const { run } = fake({ runs: [], statuses: [{ ...pass, created_at: new Date().toISOString() }], setup: { base: { ".github/workflows/ci.yml": "on: pull_request\n" } } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toEndWith("CI may not have started yet; rerun in a minute");
  });

  test("a PR with no checks, in a repository whose CI runs only on main, merges on its verdict and says so", () => {
    const { run, head } = fake({ runs: [], statuses: [aged], setup: { base: mainOnly } });
    expect(run(...merge, "--dry-run").json).toEqual({ kind: "would-merge", repo: "o/r", pr: 7, sha: head, checks: "none" });
  });

  test("failed checks refuse as failed, never as no checks", () => {
    const { run } = fake({ runs: [{ name: "unit", status: "completed", conclusion: "failure" }], statuses: [aged], gates: { noCI: "wait" } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons).toEqual(["check unit concluded failure"]);
  });

  test("a PR that changes the workflows and gets no CI result is held for a person, never merged as having no checks", () => {
    const { run, calls } = fake({ runs: [], statuses: [aged], setup: { base: { ".github/workflows/ci.yml": "on: pull_request\n" }, remove: [".github/workflows/ci.yml"] } });
    const r = run(...merge);
    expect([r.status, r.json.kind]).toEqual([1, "held"]);
    expect(r.json.reasons[0]).toContain("the PR changes .github/workflows/");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  const suite = (slug, status, conclusion, runs = 0) => ({ app: { slug, name: slug === "github-actions" ? "GitHub Actions" : slug }, status, conclusion, latest_check_runs_count: runs });

  test("a fork PR whose workflows wait for a maintainer's approval is refused, though it shows no checks", () => {
    const { run, calls } = fake({ runs: [], statuses: [aged], suites: [suite("github-actions", "completed", "action_required")], setup: { base: mainOnly } });
    const r = run(...merge);
    expect([r.status, r.json.kind]).toEqual([1, "refused"]);
    expect(r.json.reasons[0]).toContain("GitHub Actions waits for a maintainer's approval");
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("a GitHub Actions suite that has not finished is refused, though it has no runs yet", () => {
    const r = fake({ runs: [], statuses: [aged], suites: [suite("github-actions", "queued", null)], setup: { base: mainOnly } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("the GitHub Actions check suite has not finished");
  });

  test("another app's queued suite with no runs does not count, as in watch-pr", () => {
    const r = fake({ runs: [], statuses: [aged], suites: [suite("claude", "queued", null)], setup: { base: mainOnly } }).run(...merge, "--dry-run");
    expect([r.json.kind, r.json.checks]).toEqual(["would-merge", "none"]);
  });

  test("a head whose commit message skips CI cannot pass as having no checks", () => {
    const { run } = fake({ runs: [], statuses: [aged], setup: { base: mainOnly, message: "change [skip ci]" } });
    const r = run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toContain("asks GitHub to skip CI");
  });

  test("the user's noCI gate holds a PR with no CI for a person, without merging", () => {
    const { run, calls, head } = fake({ runs: [], gates: { noCI: "wait" } });
    const r = run(...merge);
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("held");
    expect(r.json.checks).toBe("none");
    expect(r.json.reasons[0]).toStartWith(`no CI result on ${head}, and the operator's gates hold such a PR for a person (noCI: wait, from `);
    expect(calls().some((a) => a[1] === "merge")).toBe(false);
  });

  test("the noCI gate holds a PR with no checks in a repository whose CI runs only on main", () => {
    const { run } = fake({ runs: [], statuses: [aged], setup: { base: mainOnly }, gates: { noCI: "wait" } });
    expect(run(...merge, "--dry-run").json.kind).toBe("held");
  });

  test("the noCI gate leaves a PR with green CI alone", () => {
    expect(fake({ gates: { noCI: "wait" } }).run(...merge, "--dry-run").json.kind).toBe("would-merge");
  });

  const repoGates = { ".potluck/gates.json": JSON.stringify({ noCI: "wait" }) };

  test("a repository's gates file at the PR's base holds it, so a PR cannot delete the gate it is judged by", () => {
    const r = fake({ runs: [], setup: { base: repoGates, remove: [".potluck/gates.json"] } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("held");
    expect(r.json.reasons[0]).toContain("from .potluck/gates.json at the PR's base");
  });

  test("a repository's gates file the PR adds holds it too", () => {
    const r = fake({ runs: [], setup: { files: repoGates } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("held");
    expect(r.json.reasons[0]).toContain("from .potluck/gates.json at the PR's head");
  });

  test("a user's gates file that cannot be read refuses rather than dropping its gates", () => {
    const r = fake({ runs: [], gates: '{"noCI": "wiat"}' }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toStartWith("operator's gates could not be read: ");
    expect(r.json.reasons[0]).toContain('noCI must be "merge" or "wait", not "wiat"');
  });

  test("a repository's gates file that cannot be read refuses too", () => {
    const r = fake({ runs: [], setup: { files: { ".potluck/gates.json": "{" } } }).run(...merge, "--dry-run");
    expect(r.json.kind).toBe("refused");
    expect(r.json.reasons[0]).toStartWith("operator's gates could not be read: .potluck/gates.json at the PR's head: not valid JSON");
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
    [["cosign", "--repo", "o/r", "--pr", "7", "--sha", sha], "--log and --evidence are required"],
    [["land", "--repo", "o/r", "--sha", sha], 'unknown command "land"'],
  ])("usage error %#", (args, message) => {
    const { run } = fake();
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });
});
