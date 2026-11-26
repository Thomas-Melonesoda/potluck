// potluck: the quality floor and overview check CI runs on every pull request,
// plugins/pstack/skills/poteto-mode/scripts/floor.mjs, run on scratch
// repositories. The floor cases came from the merge gate's tests.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FLOOR_GUARD, OVERVIEW, guardSource } from "../plugins/pstack/skills/poteto-mode/scripts/floor.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/floor.mjs");

test("the floor guard's code is the one js block in the synced floor-guard.md", () => {
  const source = guardSource(FLOOR_GUARD);
  expect(source).toContain("floor-guard");
  expect(source).toContain("process.exit(1)");
  expect(() => guardSource(join(import.meta.dir, "floor.test.mjs"))).toThrow("expected one");
});

// Stage 5 issue 17, standalone: a renamed test does not hide an untracked file left at its old path.
test("the guard on its own still reads an untracked file at a renamed test's old path", () => {
  const dir = mkdtempSync(join(tmpdir(), "potluck-guard-")), out = mkdtempSync(join(tmpdir(), "potluck-guard-script-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    g("init", "-q", "-b", "main");
    mkdirSync(join(dir, "t"));
    writeFileSync(join(dir, "t/a.test.js"), `test("a", () => { ${"expect"}(1).toBe(1); });\n`);
    g("add", "."), g("commit", "-q", "-m", "base");
    g("mv", "t/a.test.js", "t/b.test.js");
    writeFileSync(join(dir, "t/a.test.js"), `test.${"skip"}("a", () => {});\n`);
    writeFileSync(join(out, "guard.mjs"), guardSource());
    const r = spawnSync(process.execPath, [join(out, "guard.mjs"), "--base", "main"], { cwd: dir, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[test-made-easier] t/a.test.js:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
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

describe("floor.mjs on a scratch repository", () => {
  const dirs = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

  // A repository whose main holds the base and whose feature branch holds the
  // PR's head. `change` is one PR file; `base` and `files` add files before and
  // in the PR; `remove` deletes base files in the PR, `move` renames one.
  function pr({ change = { path: "src/app.js", text: "export const answer = 42;\n" }, setup: { base: baseFiles = {}, files = {}, remove = [], move = null } = {} } = {}) {
    const work = mkdtempSync(join(tmpdir(), "potluck-floor-repo-"));
    dirs.push(work);
    git(work, "init", "-q", "-b", "main");
    const put = (path, text) => {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), text);
    };
    put("src/app.js", "export const answer = 41;\n");
    for (const [path, text] of Object.entries(baseFiles)) put(path, text);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    const base = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "-c", "feature");
    put(change.path, change.text);
    for (const path of remove) git(work, "rm", "-q", path);
    for (const [path, text] of Object.entries(files)) put(path, text);
    if (move) git(work, "mv", move[0], move[1]);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "change");
    const head = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "main");
    const run = ({ from = base, cosign, cwd = work } = {}) => {
      const args = [script, "--base", from, "--head", head, ...(cosign ? ["--cosign", cosign] : [])];
      const r = spawnSync("node", args, { cwd, encoding: "utf8", env: gitEnv });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    };
    return { run, work, base, head };
  }

  test("the floor refuses a PR that adds a suppression comment, and leaves no worktree behind", () => {
    // Built in pieces, so this file does not itself add a suppression comment.
    const { run, work } = pr({ change: { path: "src/app.js", text: `// @ts-${"ignore"}\nexport const answer = 42;\n` } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/app.js"))).toBe(true);
    expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a clean change passes", () => {
    const r = pr().run();
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ kind: "pass", reasons: [] });
  });

  test("a call without --base is a usage error", () => {
    const r = spawnSync("node", [script], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: floor.mjs --base");
  });

  test("a branch cut before main gained its first CONSTRAINTS.md cannot add an exception as if it set the bar", () => {
    const repo = pr({ change: { path: "packages/a/CONSTRAINTS.md", text: "# Constraints\n\n| ID | Rule |\n|---|---|\n| W1 | no-explicit-any |\n" } });
    writeFileSync(join(repo.work, "CONSTRAINTS.md"), "# Constraints\n\n- Coverage: at least 80%\n");
    git(repo.work, "add", "CONSTRAINTS.md");
    git(repo.work, "commit", "-q", "-m", "bar");
    expect(repo.run({ from: git(repo.work, "rev-parse", "HEAD") }).json.reasons).toEqual(["floor: [new-exception] packages/a/CONSTRAINTS.md: | W1 | no-explicit-any |"]);
  });

  test("a guard that exits 2 fails: no merge base with the PR's base", () => {
    const { run, work } = pr();
    git(work, "switch", "-q", "--orphan", "lonely");
    writeFileSync(join(work, "lonely.txt"), "x\n");
    git(work, "add", "lonely.txt");
    git(work, "commit", "-q", "-m", "lonely");
    const lonely = git(work, "rev-parse", "HEAD");
    git(work, "switch", "-q", "main");
    const r = run({ from: lonely });
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("floor guard could not run");
  });

  test("a base the checkout does not hold fails, never passes", () => {
    const r = pr().run({ from: "f".repeat(40) });
    expect(r.status).toBe(1);
    expect(r.json.reasons[0]).toContain("floor guard could not run");
  });

  test("a shallow checkout that holds the base still runs the floor", () => {
    const { run, work } = pr({ change: { path: "src/app.js", text: `// eslint-${"disable"}\nexport {};\n` } });
    const shallowDir = join(work, "..", `${work.split("/").pop()}-shallow`);
    dirs.push(shallowDir);
    execFileSync("git", ["clone", "-q", "--depth", "2", "--branch", "feature", `file://${work}`, shallowDir], { env: gitEnv });
    const r = run({ cwd: shallowDir });
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/app.js"))).toBe(true);
  });

  test("the floor leaves the checkout's other worktrees alone, even one whose folder is missing for now", () => {
    const { run, work } = pr();
    const other = `${work}-other`;
    dirs.push(other);
    git(work, "worktree", "add", "-q", "-b", "side", other);
    const away = `${other}-away`;
    renameSync(other, away);
    run();
    renameSync(away, other);
    expect(git(other, "status", "--short")).toBe("");
  });

  const TEST = "src/app.test.js";
  const ASSERT = `test("adds", () => { ${"expect"}(1 + 1).toBe(2); });\n`;
  const TWO = `test("adds", () => {\n  ${"expect"}(1 + 1).toBe(2);\n  ${"expect"}(2 + 2).toBe(4);\n});\n`;

  // Stage 5 issue 17: a changed assertion waits for the root agent's co-sign
  // instead of failing outright. CI passes the fingerprints co-signed for the head.
  const CHANGED = TWO.replace("toBe(4)", "toBe(5)");
  const changed = () => pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: CHANGED } } });
  const FINDING = `floor: [assertion-changed] ${TEST}: ${"expect"}(2 + 2).toBe(4);  ->  ${"expect"}(2 + 2).toBe(5);`;

  test("a changed assertion fails until the root agent co-signs it, and the hint names the comment to post", () => {
    const { run, head } = changed();
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.cosign).toMatch(/^[0-9a-f]{16}$/);
    expect(r.json.reasons[0]).toBe(FINDING);
    expect(r.json.reasons[1]).toContain("needs the root agent's co-sign");
    expect(r.json.reasons[1]).toContain(`potluck-cosign: ${head} ${r.json.cosign}`);
  });

  test("the co-signed fingerprint clears those findings", () => {
    const { run } = changed();
    const cosign = run().json.cosign;
    const r = run({ cosign: `0123456789abcdef,${cosign}` });
    expect(r.status).toBe(0);
    expect(r.json.kind).toBe("pass");
  });

  test("a co-sign of other findings does not clear these", () => {
    expect(changed().run({ cosign: "0123456789abcdef" }).json.reasons[0]).toBe(FINDING);
  });

  test("a co-sign cannot clear a removed assertion", () => {
    const repo = pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: TWO.replace(`  ${"expect"}(2 + 2).toBe(4);\n`, "") } } });
    const r = repo.run();
    expect(r.json.cosign).toBeUndefined();
    expect(r.json.reasons).toEqual([`floor: [assertion-removed] ${TEST}: ${"expect"}(2 + 2).toBe(4);`]);
  });

  test("a stub is stopped", () => {
    const { run } = pr({ change: { path: "src/app.js", text: `export function later() { throw new Error("Not ${"implemented"}"); }\n` } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[unfinished-work]"))).toBe(true);
  });

  test("Markdown that describes the floor's patterns passes, and CONSTRAINTS.md still counts", () => {
    const docs = pr({ change: { path: "notes.md", text: `Never add @ts-${"ignore"} or leave a ${"TO"}DO.\n` } });
    expect(docs.run().json.kind).toBe("pass");
    const bar = pr({ change: { path: "CONSTRAINTS.md", text: `# Constraints\n\n## Exceptions\n\n| ID | Rule |\n|---|---|\n| W1 | no-${"explicit"}-any |\n` }, setup: { base: { "CONSTRAINTS.md": "# Constraints\n" } } });
    const r = bar.run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[new-exception] CONSTRAINTS.md"))).toBe(true);
  }, 15_000);

  const TEMPLATE = readFileSync(join(import.meta.dir, "../plugins/pstack/skills/constraint-driven-development/SKILL.md"), "utf8")
    .match(/^### Step 3[\s\S]*?^```markdown\n([\s\S]*?)^```$/m)[1];

  test("the skill's own CONSTRAINTS.md template passes the floor", () => {
    const { run } = pr({ change: { path: "CONSTRAINTS.md", text: TEMPLATE.replace(/^\| W1 \|.*\n/m, "") } });
    expect(run().json.kind).toBe("pass");
  });

  test("over a CONSTRAINTS.md already in place, the template's example exception row is its only floor finding", () => {
    const r = pr({ change: { path: "CONSTRAINTS.md", text: TEMPLATE }, setup: { base: { "CONSTRAINTS.md": "# Constraints\n" } } }).run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons).toHaveLength(1);
    expect(r.json.reasons[0]).toStartWith("floor: [new-exception] CONSTRAINTS.md: | W1 |");
  });

  const rule = (text) => `# 约束\n\n## 底线\n\n- 测试覆盖率：${text}\n`;
  const editRule = (from, to) => pr({ change: { path: "CONSTRAINTS.md", text: rule(to) }, setup: { base: { "CONSTRAINTS.md": rule(from) } } }).run();

  test("a rule written with a full-width colon keeps its key, so rewording it is not a removal", () => {
    expect(editRule("改动的行至少 80%", "每次改动的行至少 80%").json.kind).toBe("pass");
  });

  test("a loosened threshold in a rule written with a full-width colon reads as loosened", () => {
    const r = editRule(">= 80%", ">= 70%");
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: - 测试覆盖率：>= 80%  ->  - 测试覆盖率：>= 70%"]);
  });

  test("two rules that share a key each need a counterpart, so deleting one while editing the other is a removal", () => {
    const bullet = "- Coverage: changed lines at least 80% covered\n";
    const table = "| Dimension | Rule | Checked by |\n|---|---|---|\n| Coverage | Changed lines ≥ 80% covered | `vitest run --coverage` |\n";
    const before = `# Constraints\n\n## Floor\n\n${bullet}\n## Enforced with numbers\n\n${table}`;
    const after = before.replace(bullet, "").replace("`vitest run --coverage` |", "`vitest run --coverage` + git diff |");
    const r = pr({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run();
    expect(r.json.kind).toBe("fail");
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
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toStartWith("floor: [threshold-removed] CONSTRAINTS.md:");
  });

  test("a Chinese ratchet row that falls reads as loosened", () => {
    const table = (n) => `# 约束\n\n## 已测量\n\n| 指标 | 今天 | 方向 |\n|---|---|---|\n| 项目覆盖率 | ${n}% | 不得下降 |\n`;
    const r = pr({ change: { path: "CONSTRAINTS.md", text: table("60") }, setup: { base: { "CONSTRAINTS.md": table("62.4") } } }).run();
    expect(r.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: | 项目覆盖率 | 62.4% | 不得下降 |  ->  | 项目覆盖率 | 60% | 不得下降 |"]);
  });

  test("a Chinese word that runs on past its number, or an ambiguous 最高, gives no direction either", () => {
    const bar = (a, b, c, d, e) => `# 约束\n\n- 行覆盖率：${a}% 以下 3 个目录除外\n- 历史覆盖率：历史最高 ${b}%，不得下降\n- 项目覆盖率：不得下降到 ${c}% 以下\n\n| 指标 | 门槛 | 说明 |\n|---|---|---|\n| 函数覆盖率 | ${d}% | 以下 3 个目录除外：src/a、src/b |\n| 包大小 | ${e} KB | 以上 2 条适用于所有包 |\n`;
    const r = pr({ change: { path: "CONSTRAINTS.md", text: bar(60, 60, 60, 60, 500) }, setup: { base: { "CONSTRAINTS.md": bar(80, 80, 80, 80, 200) } } }).run();
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
    const r = pr({ change: { path: "CONSTRAINTS.md", text: bar(500, 30, 500, 150, 500) }, setup: { base: { "CONSTRAINTS.md": bar(200, 10, 200, 200, 200) } } }).run();
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
    const r = pr({ change: { path: "CONSTRAINTS.md", text: bar(60, 1, 500, 60, 60, 60, 60, 300) }, setup: { base: { "CONSTRAINTS.md": bar(80, 2, 1000, 80, 80, 80, 80, 184) } } }).run();
    expect(r.json.reasons.map((l) => l.match(/^floor: \[([a-z-]+)\]/)?.[1])).toEqual([...Array(6).fill("threshold-loosened"), "threshold-changed", "threshold-changed"]);
  });

  test("dropping the words around a number whose words disagree reads as removed, and 甚至少 is not 至少", () => {
    const before = "# Constraints\n\n- Coverage: never below 80%, must not drop\n- Lighthouse: fails below 90, must not drop\n- Small files: files under 2 KB must not drop\n- 覆盖率：不得下降，甚至少 1% 也不行\n\n| Metric | Bar | Direction |\n|---|---|---|\n| Line coverage | not under 80% | must not drop |\n| Branch coverage | fails if < 80% | must not drop |\n| Statement coverage | never below 80% | must not fall |\n";
    const after = before.replace("never below 80%, must not drop", "80% target").replace("fails below 90, must not drop", "90 is the goal").replace("files under 2 KB must not drop", "2 KB files may drop").replace("甚至少 1%", "甚至少 5%")
      .replace("not under 80% | must not drop", "80% | advisory").replace("fails if < 80% | must not drop", "80% | informational").replace("never below 80% | must not fall", "80% | may fall");
    const r = pr({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run();
    expect(r.json.reasons.map((l) => l.match(/^floor: \[([a-z-]+)\]/)?.[1])).toEqual(["threshold-removed", "threshold-removed", "threshold-removed", "threshold-changed", "threshold-removed", "threshold-removed", "threshold-removed"]);
  });

  test("a lower bar added in front of one whose words disagree is still a loosening", () => {
    const before = "# Constraints\n\n- Coverage: at least 80%\n- Lighthouse: at least 90\n\n| Metric | Bar | Direction |\n|---|---|---|\n| Line coverage | at least 80% | |\n| 覆盖率 | 不超过 80% | 不得下降 |\n";
    const after = before.replace("- Coverage: at least 80%", "- Coverage: never below 60%, must not drop; at least 80% for new code").replace("- Lighthouse: at least 90", "- Lighthouse: fails below 70, must not drop; at least 90 on the home page")
      .replace("| Line coverage | at least 80% | |", "| Line coverage | fails if < 60%, must not drop; at least 80% for new code | |").replace("| 不超过 80% |", "| 至少 60%，不超过 80% |");
    const r = pr({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run();
    expect(r.json.reasons.map((l) => l.match(/^floor: \[([a-z-]+)\]/)?.[1])).toEqual(["threshold-loosened", "threshold-loosened", "threshold-loosened", "threshold-changed"]);
  });

  test("a test command in plain .md under ci_scripts/ is not a CI step", () => {
    const r = pr({ change: { path: "ci_scripts/README.md", text: "Run the suite first.\n" }, setup: { base: { "ci_scripts/README.md": "Run npm test first.\n" } } }).run();
    expect(r.json.kind).toBe("pass");
  });

  test("a path with a space keeps its name, so plain .md stays unchecked and a Swift test there is still a test", () => {
    const swift = "My App Tests/AppTests.swift";
    const r = pr({ change: { path: "docs/Meeting notes.md", text: `Leave a ${"TO"}DO here.\n` }, setup: { base: { [swift]: XCTEST }, remove: [swift] } }).run();
    expect(r.json.reasons).toEqual([`floor: [test-deleted] ${swift}: file deleted`]);
  });

  test("Chinese words that only sit near a number give it no direction, so a change to it is still reported", () => {
    const bar = (a, b, c, d, e) => `# 约束\n\n- 包大小：${a}KB，以上规则适用于所有包\n- 行覆盖率：${b}%（以下目录除外：src/legacy）\n- 测试覆盖率：${c}%，三个月以内提高到 90%\n- 分支覆盖率：低于 ${d}% 即失败\n\n| 指标 | 门槛 | 说明 |\n|---|---|---|\n| 函数覆盖率 | ${e}% | 以下目录除外：src/legacy |\n`;
    const r = pr({ change: { path: "CONSTRAINTS.md", text: bar(500, 60, 60, 60, 60) }, setup: { base: { "CONSTRAINTS.md": bar(200, 80, 80, 80, 80) } } }).run();
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
    const r = pr({ change: { path: "CONSTRAINTS.md", text } }).run();
    expect(r.json.reasons).toEqual(['floor: [duplicate-rule] CONSTRAINTS.md: "覆盖率" names 2 rules (lines 5, 6); rule names must be unique']);
  });

  test("a table row that repeats a bullet's name is refused", () => {
    const before = "# Constraints\n\n## Floor\n\n- Coverage: changed lines at least 80% covered\n";
    const after = `${before}\n## Enforced\n\n| Dimension | Rule |\n|---|---|\n| Coverage | Changed lines ≥ 80% covered |\n`;
    const r = pr({ change: { path: "CONSTRAINTS.md", text: after }, setup: { base: { "CONSTRAINTS.md": before } } }).run();
    expect(r.json.reasons).toEqual(['floor: [duplicate-rule] CONSTRAINTS.md: "Coverage" names 2 rules (lines 5, 11); rule names must be unique']);
  });

  test("tables that share a header and a separator do not repeat a rule", () => {
    const text = "# Constraints\n\n## Fast\n\n| Rule | Why |\n|---|---|\n| Types | zero errors |\n\n## Slow\n\n| Rule | Why |\n|---|---|\n| Audit | nothing high |\n";
    expect(pr({ change: { path: "CONSTRAINTS.md", text } }).run().json.kind).toBe("pass");
  });

  test("nested bullets and a fenced example do not repeat a rule", () => {
    const text = "# Constraints\n\n- Coverage: at least 80%\n  - Tool: vitest\n- Lint: zero errors\n  - Tool: biome\n\n```markdown\n- Coverage: an example\n```\n";
    expect(pr({ change: { path: "CONSTRAINTS.md", text } }).run().json.kind).toBe("pass");
  });

  test("a repeated name in a CONSTRAINTS.md the change leaves alone does not block it", () => {
    const text = "# Constraints\n\n- Coverage: at least 80%\n- Coverage: must not fall\n";
    expect(pr({ setup: { base: { "CONSTRAINTS.md": text } } }).run().json.kind).toBe("pass");
  });

  // Stage 5 issue 7: Swift tests, and the CI step that runs the tests.
  const SWIFT = "Tests/AppTests/AppTests.swift";
  const XCTEST = "import XCTest\n\nfinal class AppTests: XCTestCase {\n  func testAnswer() {\n    XCTAssertEqual(answer, 42)\n  }\n}\n";

  test("deleting a Swift test file is stopped", () => {
    const r = pr({ setup: { base: { [SWIFT]: XCTEST }, remove: [SWIFT] } }).run();
    expect(r.json.reasons).toEqual([`floor: [test-deleted] ${SWIFT}: file deleted`]);
  });

  test("an XCTSkip added to a Swift test is stopped", () => {
    const skipped = XCTEST.replace("  func testAnswer() {\n", `  func testAnswer() throws {\n    throw XCT${"Skip"}("later")\n`);
    const r = pr({ setup: { base: { [SWIFT]: XCTEST }, files: { [SWIFT]: skipped } } }).run();
    expect(r.json.reasons).toEqual([`floor: [test-made-easier] ${SWIFT}: throw XCT${"Skip"}("later")`]);
  });

  test("XCTSkip named in prose is not a skip", () => {
    expect(pr({ change: { path: "src/notes.json", text: `{ "why": "XCT${"Skip"} counts as a skip" }\n` } }).run().json.kind).toBe("pass");
  });

  test("an XCTAssert removed from a Swift test that stayed is stopped", () => {
    const r = pr({ setup: { base: { [SWIFT]: XCTEST }, files: { [SWIFT]: XCTEST.replace("    XCTAssertEqual(answer, 42)\n", "") } } }).run();
    expect(r.json.reasons).toEqual([`floor: [assertion-removed] ${SWIFT}: XCTAssertEqual(answer, 42)`]);
  });

  const CI = ".github/workflows/ci.yml";
  const WORKFLOW = (steps) => `on: pull_request\njobs:\n  test:\n    runs-on: macos-latest\n    steps:\n      - uses: actions/checkout@v4\n${steps}`;

  test("a test step removed from CI configuration is stopped", () => {
    const r = pr({ change: { path: CI, text: WORKFLOW("") }, setup: { base: { [CI]: WORKFLOW("      - run: swift test\n") } } }).run();
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${CI}: - run: swift test`]);
  });

  test("a CI test step commented out is stopped", () => {
    const r = pr({ change: { path: CI, text: WORKFLOW("      # - run: swift test\n") }, setup: { base: { [CI]: WORKFLOW("      - run: swift test\n") } } }).run();
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${CI}: - run: swift test`]);
  });

  test("a CI test step moved to another workflow passes", () => {
    const moved = { base: { [CI]: WORKFLOW("      - run: swift test --parallel\n") }, files: { ".github/workflows/test.yml": WORKFLOW("      - run: swift test\n") } };
    expect(pr({ change: { path: CI, text: WORKFLOW("") }, setup: moved }).run().json.kind).toBe("pass");
  });

  test("CI edits that keep the tests running pass", () => {
    const step = (name, run) => WORKFLOW(`      - name: ${name}\n        run: ${run}\n`);
    const setup = { base: { [CI]: step("Run npm test", "npm test"), ".github/workflows/README.md": "Run bun test locally first.\n" }, files: { ".github/workflows/README.md": "Run the suite locally first.\n" } };
    expect(pr({ change: { path: CI, text: step("Unit tests", "pnpm run test:ci") }, setup }).run().json.kind).toBe("pass");
  });

  test("a JS test step swapped for another JS test runner passes", () => {
    const steps = (a, b) => WORKFLOW(`      - run: ${a}\n      - run: ${b}\n`);
    expect(pr({ change: { path: CI, text: steps("npx vitest run", "pnpm -r test") }, setup: { base: { [CI]: steps("npm test", "pnpm test") } } }).run().json.kind).toBe("pass");
  });

  test("a test step removed from a composite action, after an install on its line, is stopped", () => {
    const ACTION = ".github/actions/check/action.yml";
    const action = (run) => `runs:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`;
    const r = pr({ change: { path: ACTION, text: action("pip install pytest") }, setup: { base: { [ACTION]: action("pip install pytest && pytest") } } }).run();
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
    const r = pr({ setup: { files } }).run();
    const flagged = r.json.reasons.map((l) => l.match(/^floor: \[silenced-checker\] (.+?): /)?.[1]).filter(Boolean);
    expect(flagged.sort()).toEqual(Object.keys(files).filter((f) => f !== "notes.md").sort());
  });

  test("CONSTRAINTS.md is plain Markdown, yet a lowered number in it is stopped", () => {
    const before = "# Constraints\n\n- Coverage: changed lines at least 80% covered\n";
    const r = pr({ change: { path: "CONSTRAINTS.md", text: before.replace("80%", "70%") }, setup: { base: { "CONSTRAINTS.md": before } } }).run();
    expect(r.json.reasons).toEqual(["floor: [threshold-loosened] CONSTRAINTS.md: - Coverage: changed lines at least 80% covered  ->  - Coverage: changed lines at least 70% covered"]);
  });

  // Build the lever (S3-B5): the floor counts as working only while both canaries hold.
  describe("floor canaries", () => {
    test("the skill's CONSTRAINTS.md template passes as written", () => {
      expect(pr({ change: { path: "CONSTRAINTS.md", text: TEMPLATE } }).run().json.kind).toBe("pass");
    });

    test("a code file with a deliberate suppression is stopped", () => {
      const r = pr({ change: { path: "src/app.ts", text: `// @ts-${"ignore"}\nexport const answer: number = "42";\n` } }).run();
      expect(r.json.reasons).toEqual([`floor: [silenced-checker] src/app.ts: // @ts-${"ignore"}`]);
    });
  });


  test("a PR's own .gitattributes cannot hide a finding", () => {
    const { run } = pr({ change: { path: ".gitattributes", text: "* -diff\n" }, setup: { base: { [TEST]: ASSERT }, files: { [TEST]: `${ASSERT}test.${"skip"}("later", () => {});\n` } } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[test-made-easier]"))).toBe(true);
  });

  test("renaming a test file away counts as deleting it", () => {
    const { run } = pr({ change: { path: "src/note.js", text: "export {};\n" }, setup: { base: { [TEST]: ASSERT }, move: [TEST, "src/app.check.js"] } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[test-deleted] src/app.test.js"))).toBe(true);
  });

  // Stage 5 issue 17: a renamed test is only renamed.

  test("a test file renamed to another test name passes", () => {
    const { run } = pr({ setup: { base: { [TEST]: TWO }, move: [TEST, "src/sum.test.js"] } });
    expect(run().json.kind).toBe("pass");
  });

  test("a renamed test file's old skip does not read as new", () => {
    const { run } = pr({ setup: { base: { [TEST]: `${TWO}test.${"skip"}("later", () => {});\n` }, move: [TEST, "src/sum.test.js"] } });
    expect(run().json.kind).toBe("pass");
  });

  test("a test renamed with edits was not only renamed, so it reads as deleted, as on main", () => {
    const fewer = TWO.replace(`  ${"expect"}(2 + 2).toBe(4);\n`, "");
    const { run } = pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: fewer }, move: [TEST, "src/sum.test.js"] } });
    expect(run().json.reasons).toEqual([`floor: [test-deleted] ${TEST}: file deleted`]);
  });

  test("a rename that changes the content, or drops one of two naming forms, reads as deleted", () => {
    const py = "pkg/test_math_test.py", rb = "test/test_user_test.rb", js = "src/a.test.js";
    const pyText = "def test_add():\n    assert 1 + 1 == 2\n", rbText = "require 'minitest/autorun'\n";
    const setup = { base: { [py]: pyText, [rb]: rbText, [js]: TWO }, files: { "pkg/math_test.py": pyText, "test/user_test.rb": rbText, "src/b.test.js": `${TWO}// renamed\n` }, remove: [py, rb, js] };
    expect(pr({ setup }).run().json.reasons.sort()).toEqual([py, rb, js].map((f) => `floor: [test-deleted] ${f}: file deleted`).sort());
  });

  test("a CONSTRAINTS.md renamed away reads as every rule removed", () => {
    const bar = "# Constraints\n\n- Coverage: changed lines at least 80% covered\n";
    const { run } = pr({ setup: { base: { "CONSTRAINTS.md": bar }, move: ["CONSTRAINTS.md", "old-rules.md"] } });
    expect(run().json.reasons).toEqual(["floor: [rule-removed] CONSTRAINTS.md: - Coverage: changed lines at least 80% covered"]);
  });

  test("an assertion moved within its test file waits for the co-sign too", () => {
    const swapped = `test("adds", () => {\n  ${"expect"}(2 + 2).toBe(4);\n  ${"expect"}(1 + 1).toBe(2);\n});\n`;
    const r = pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: swapped } } }).run();
    expect(r.json.reasons[0]).toStartWith(`floor: [assertion-moved] ${TEST}: `);
    expect(r.json.reasons.at(-1)).toContain("needs the root agent's co-sign");
  });

  test("a test renamed to a name no runner picks up still reads as deleted", () => {
    const go = "mathx/add_test.go", py = "tests/test_math.py", pyText = "def test_add():\n    assert 1 + 1 == 2\n";
    const setup = { base: { [TEST]: TWO, [go]: "package mathx\n", [py]: pyText }, files: { "src/app.test.js.disabled": TWO, "mathx/testdata/add_test.go": "package mathx\n", "tests/latest_math.py": pyText }, remove: [TEST, go, py] };
    expect(pr({ setup }).run().json.reasons.sort()).toEqual([go, TEST, py].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a test moved to another runner's naming, or into a folder runners skip, still reads as deleted", () => {
    const go = "mathx/add_test.go", py = "tests/test_math.py", js = "src/math.test.js", nm = "src/b.test.js";
    const goText = "package mathx\n", pyText = "def test_add():\n    assert 1 + 1 == 2\n", jsText = TWO.replace("adds", "math");
    const setup = { base: { [go]: goText, [py]: pyText, [js]: jsText, [nm]: TWO }, files: { "mathx/add.test.go": goText, "tests/math.test.py": pyText, "src/test_math.js": jsText, "node_modules/x/b.test.js": TWO }, remove: [go, py, js, nm] };
    expect(pr({ setup }).run().json.reasons.sort()).toEqual([go, nm, js, py].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a test renamed in its folder to a name a runner's discovery skips reads as deleted", () => {
    const js = "src/a.test.mjs", swift = "Tests/AppTests/BTests.swift", rb = "test/a_test.rb", py = "pkg/test_math.py", py2 = "pkg/test_calc.py";
    const pyText = "def test_add():\n    assert 1 + 1 == 2\n";
    const base = { [js]: TWO, [swift]: "import XCTest\nfinal class BTests: XCTestCase {}\n", [rb]: "require 'minitest/autorun'\n", [py]: pyText, [py2]: pyText.replace("add", "sub") };
    const files = { "src/.a.test.mjs": base[js], "Tests/AppTests/.BTests.swift": base[swift], "test/.a_test.rb": base[rb], "pkg/test_math-old.py": base[py], "pkg/test_calc.old.py": base[py2] };
    const r = pr({ setup: { base, files, remove: Object.keys(base) } }).run();
    expect(r.json.reasons.sort()).toEqual([swift, js, rb, py2, py].map((f) => `floor: [test-deleted] ${f}: file deleted`).sort());
  });

  test("a rename git scores R100 whose content still changed reads as deleted", () => {
    const before = `test("t", () => {\n  ${"expect"}(1 + 1).toBe(3);\n  return;\n});\n`;
    const after = `test("t", () => {\n  return;\n  ${"expect"}(1 + 1).toBe(3);\n});\n`;
    const r = pr({ setup: { base: { "src/a.test.js": before }, files: { "src/b.test.js": after }, remove: ["src/a.test.js"] } }).run();
    expect(r.json.reasons).toEqual(["floor: [test-deleted] src/a.test.js: file deleted"]);
  });

  test("a folder at a renamed test's old path is still read", () => {
    const r = pr({ setup: { base: { "src/a.test.js": TWO }, files: { "src/b.test.js": TWO, "src/a.test.js/x.ts": `// @ts-${"ignore"}\nexport const x = 1;\n` }, remove: ["src/a.test.js"] } }).run();
    expect(r.json.reasons).toEqual([`floor: [silenced-checker] src/a.test.js/x.ts: // @ts-${"ignore"}`]);
  });

  test("a rename that changes what any runner's default naming reads reads as deleted", () => {
    const js = "src/test-foo.spec.js", py = "pkg/testing_test.py", rb = "test/testing_test.rb";
    const base = { [js]: TWO, [py]: "def test_add():\n    assert 1 + 1 == 2\n", [rb]: "require 'minitest/autorun'\n" };
    const files = { "src/foo.spec.js": base[js], "pkg/foo_test.py": base[py], "test/foo_test.rb": base[rb] };
    const r = pr({ setup: { base, files, remove: Object.keys(base) } }).run();
    expect(r.json.reasons.sort()).toEqual([py, js, rb].map((f) => `floor: [test-deleted] ${f}: file deleted`).sort());
  });

  test("a rename minitest or test-unit stops reading, or one that orphans a snapshot, reads as deleted", () => {
    const rb = "test/test_parser.rb", rb2 = "test/test_lexer.rb", js = "src/foo.test.js";
    const base = { [rb]: "require 'minitest/autorun'\n", [rb2]: "require 'minitest/autorun' # lexer\n", [js]: TWO, "src/__snapshots__/foo.test.js.snap": "exports[`adds 1`] = `2`;\n" };
    const files = { "test/testparser.rb": base[rb], "test/test-lexer.rb": base[rb2], "src/bar.test.js": TWO };
    const r = pr({ setup: { base, files, remove: [rb, rb2, js] } }).run();
    expect(r.json.reasons.sort()).toEqual([js, rb2, rb].map((f) => `floor: [test-deleted] ${f}: file deleted`).sort());
  });

  test("a CI file with a test-like name moved out of the CI paths still reads as its test step removed", () => {
    const UNIT = ".github/workflows/unit_test.yml", step = WORKFLOW("      - run: npm test\n");
    const r = pr({ setup: { base: { [UNIT]: step }, files: { ".github/unit_test.yml": step }, remove: [UNIT] } }).run();
    expect(r.json.reasons.sort()).toEqual([`floor: [ci-test-removed] ${UNIT}: - run: npm test`, `floor: [test-deleted] ${UNIT}: file deleted`]);
  });

  test("a test moved to another folder reads as deleted, as on main, since the folder decides what runs it", () => {
    const swift = "Tests/AppTests/MathTests.swift", rb = "test/test_user.rb";
    const swiftText = "import XCTest\nfinal class MathTests: XCTestCase {}\n", rbText = "require 'minitest/autorun'\n";
    const setup = { base: { [TEST]: TWO, [swift]: swiftText, [rb]: rbText }, files: { "src/__tests__/app.test.js": TWO, "Archive/MathTests.swift": swiftText, "lib/test_user.rb": rbText }, remove: [TEST, swift, rb] };
    expect(pr({ setup }).run().json.reasons.sort()).toEqual([swift, TEST, rb].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a test renamed in its folder to a name Go skips, or to another naming form, reads as deleted", () => {
    const go = "mathx/add_test.go", sub = "mathx/sub_test.go", py = "tests/test_math.py", js = "src/math.test.js";
    const goText = "package mathx\n", pyText = "def test_add():\n    assert 1 + 1 == 2\n", jsText = TWO.replace("adds", "math");
    const setup = { base: { [go]: goText, [sub]: "package mathx // sub\n", [py]: pyText, [js]: jsText }, files: { "mathx/_add_test.go": goText, "mathx/sub_windows_test.go": "package mathx // sub\n", "tests/math_test.py": pyText, "src/math.spec.js": jsText }, remove: [go, sub, py, js] };
    expect(pr({ setup }).run().json.reasons.sort()).toEqual([go, sub, js, py].map((f) => `floor: [test-deleted] ${f}: file deleted`));
  });

  test("a CI file renamed out of the CI paths still reads as its test step removed", () => {
    const step = WORKFLOW("      - run: npm test\n");
    const r = pr({ setup: { base: { [CI]: step }, files: { ".github/ci.yml.off": step }, remove: [CI] } }).run();
    expect(r.json.reasons).toEqual([`floor: [ci-test-removed] ${CI}: - run: npm test`]);
  });

  test("a Markdown file renamed into code brings its forbidden forms with it", () => {
    const text = `// @ts-${"ignore"}\nexport const x = 1;\n`;
    const r = pr({ setup: { base: { "docs/snippet.md": text }, files: { "src/snippet.ts": text }, remove: ["docs/snippet.md"] } }).run();
    expect(r.json.reasons).toEqual([`floor: [silenced-checker] src/snippet.ts: // @ts-${"ignore"}`]);
  });

  test("an assertion commented out is removed, not changed", () => {
    const off = TWO.replace(`  ${"expect"}(2 + 2)`, `  // ${"expect"}(2 + 2)`);
    const r = pr({ setup: { base: { [TEST]: TWO }, files: { [TEST]: off } } }).run();
    expect(r.json.reasons).toEqual([`floor: [assertion-removed] ${TEST}: ${"expect"}(2 + 2).toBe(4);`]);
  });

  test("a colon in a code file's name does not make its finding look like Markdown", () => {
    const { run } = pr({ change: { path: "src/x.md:y.js", text: `// eslint-${"disable"}\nexport {};\n` } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[silenced-checker] src/x.md:y.js"))).toBe(true);
  });

  test("the checkout's own git config cannot switch the floor off", () => {
    const { run, work } = pr({ setup: { base: { [TEST]: ASSERT }, files: { [TEST]: `${ASSERT}test.${"skip"}("later", () => {});\n` } } });
    git(work, "config", "diff.external", "true");
    git(work, "config", "color.ui", "always");
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.some((l) => l.includes("[test-made-easier]"))).toBe(true);
  });

  test("a PR's .gitattributes cannot re-encode a test file on checkout to hide it", () => {
    // The file is written as UTF-16LE with a BOM, as the attribute says, so git
    // stores it as UTF-8 and a checkout under the PR's attributes would write
    // it back as UTF-16, which the guard reads as binary.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${ASSERT}test.${"skip"}("later", () => {});\n`, "utf16le")]);
    const { run } = pr({ change: { path: ".gitattributes", text: "*.test.js working-tree-encoding=UTF-16LE-BOM\n" }, setup: { base: { [TEST]: ASSERT }, files: { [TEST]: utf16 } } });
    const r = run();
    // The fixture commits the attribute and the file together, so git converts
    // the blob on add; either way the floor must see the change and refuse.
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons.every((l) => l.startsWith("floor: ["))).toBe(true);
  });
  test("deleting a committed binary file passes the binary check", () => {
    const { run } = pr({ setup: { base: { ".DS_Store": Buffer.from([0, 1, 2, 3, 0]) }, remove: [".DS_Store"] } });
    expect(run().json.kind).toBe("pass");
  });

  const FEATURE = "# Votes\n\nLets a club vote.\n\nFor: book clubs.\n\n## Done when\n\n- [ ] A member can vote once.\n";

  test("a PR that changes a feature file without regenerating the overview fails", () => {
    const { run } = pr({ change: { path: "docs/features/votes.md", text: FEATURE } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("overview: docs/overview.md is stale or missing");
  });

  test("a project with only an ADR passes without an overview", () => {
    const { run } = pr({ change: { path: "docs/adr/0001-use-postgres.md", text: "# Use Postgres\n" } });
    expect(run().json.kind).toBe("pass");
  });

  test("the overview is checked even when the floor's only findings are in Markdown", () => {
    const { run } = pr({ change: { path: "docs/features/votes.md", text: FEATURE }, setup: { files: { "notes.md": `Never add @ts-${"ignore"}.\n` } } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("overview: docs/overview.md is stale or missing");
  });

  test("a PR that ticks a Done when item without proof fails", () => {
    const { run } = pr({ change: { path: "docs/features/votes.md", text: FEATURE.replace("- [ ]", "- [x]") } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("ticked without proof");
  });

  test("a PR with its overview regenerated passes", () => {
    const root = mkdtempSync(join(tmpdir(), "potluck-floor-ov-"));
    dirs.push(root);
    mkdirSync(join(root, "docs/features"), { recursive: true });
    writeFileSync(join(root, "docs/features/votes.md"), FEATURE);
    spawnSync("node", [OVERVIEW, "--root", root, "--write"]);
    const overview = readFileSync(join(root, "docs/overview.md"), "utf8");
    const { run } = pr({ change: { path: "docs/features/votes.md", text: FEATURE }, setup: { files: { "docs/overview.md": overview } } });
    expect(run().json.kind).toBe("pass");
  });

  test("a NUL byte in an extension-less script is refused too", () => {
    const { run } = pr({ change: { path: "bin/run", text: `#!/usr/bin/env node\n/*\0*/\n// eslint-${"disable"}\n` } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("[binary-source] bin/run");
  });

  test("a binary image passes the binary check", () => {
    const { run } = pr({ change: { path: "logo.png", text: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) } });
    expect(run().json.kind).toBe("pass");
  });

  test("a NUL byte that makes a source file binary is refused, since the floor cannot read it", () => {
    const { run } = pr({ setup: { base: { [TEST]: ASSERT }, files: { [TEST]: `/*\0*/\n${ASSERT}test.${"skip"}("later", () => {});\n` } } });
    const r = run();
    expect(r.json.kind).toBe("fail");
    expect(r.json.reasons[0]).toContain("[binary-source] src/app.test.js");
  });
});
