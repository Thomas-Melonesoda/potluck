// potluck: each component in tools/upstream.json may name its own remote, so
// upstreams in different repositories (pstack, Matt Pocock's skills, Addy
// Osmani's agent-skills) can be synced side by side.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIMES } from "../tools/runtimes.mjs";
import { parseUpstream, remoteOf } from "../tools/sync.mjs";

const tools = join(import.meta.dir, "../tools");
const roots = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

describe("parseUpstream remotes", () => {
  test("a component's own remote wins over the top-level one", () => {
    const doc = parseUpstream({ remote: "top", components: { a: { sha: "1" }, b: { sha: "2", remote: "own" } } });
    expect(remoteOf(doc, "a")).toBe("top");
    expect(remoteOf(doc, "b")).toBe("own");
  });

  test("a component with no remote anywhere fails naming it", () => {
    expect(() => parseUpstream({ components: { a: { sha: "1" } } })).toThrow(
      'upstream.json: component "a" has no remote; set "remote" on it or at the top level',
    );
  });

  test("a remote that is not a non-empty string fails naming where it is", () => {
    expect(() => parseUpstream({ remote: "", components: {} })).toThrow('upstream.json: "remote" must be a non-empty string');
    expect(() => parseUpstream({ remote: "top", components: { a: { remote: 7 } } })).toThrow(
      'upstream.json: component "a" remote must be a non-empty string',
    );
  });
});

describe("sync CLI with two remotes", () => {
  function repo(root, name, files) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv }).trim();
    git("init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "init");
    return { dir, sha: git("rev-parse", "HEAD") };
  }

  function port(root, upstream) {
    const dir = join(root, "port");
    for (const file of ["sync.mjs", "generate.mjs", "plugin.mjs", "runtimes.mjs", "validate-skills.mjs", "substitutions.json"]) {
      cpSync(join(tools, file), join(dir, "tools", file));
    }
    symlinkSync(join(import.meta.dir, "../node_modules"), join(dir, "node_modules"));
    cpSync(join(import.meta.dir, "../plugins/pstack/models.json"), join(dir, "plugins/pstack/models.json"));
    for (const runtime of RUNTIMES) {
      mkdirSync(join(dir, runtime.tools, ".."), { recursive: true });
      writeFileSync(join(dir, runtime.tools), `${runtime.notesHeader}\n|-------|----------|\n`);
    }
    for (const { skill } of JSON.parse(readFileSync(join(dir, "plugins/pstack/models.json"), "utf8")).roles) {
      mkdirSync(join(dir, "plugins/pstack/skills", skill), { recursive: true });
      writeFileSync(join(dir, "plugins/pstack/skills", skill, "SKILL.md"), "");
    }
    writeFileSync(join(dir, "tools/upstream.json"), JSON.stringify(upstream));
    writeFileSync(join(dir, "tools/forks.json"), JSON.stringify({}));
    return dir;
  }

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "potluck-remotes-"));
    roots.push(root);
    const lauren = repo(root, "lauren", { "pstack/skills/a/notes.md": "from lauren\n" });
    const matt = repo(root, "matt", { "skills/grill/notes.md": "from matt, use the Task tool\n" });
    const dir = port(root, {
      components: {
        pstack: { remote: lauren.dir, upstreamPath: "pstack", localPath: "plugins/pstack", sha: lauren.sha, exclude: [] },
        matt: { remote: matt.dir, upstreamPath: "skills", localPath: "plugins/pstack/skills", sha: matt.sha, exclude: [] },
      },
    });
    for (const [path, text] of [["a/notes.md", "from lauren\n"], ["grill/notes.md", "from matt, use the Agent tool\n"]]) {
      mkdirSync(join(dir, "plugins/pstack/skills", path, ".."), { recursive: true });
      writeFileSync(join(dir, "plugins/pstack/skills", path), text);
    }
    const rule = (pattern) => ({ pattern, replacement: "Agent tool", rationale: "fixture" });
    const rules = (...patterns) =>
      writeFileSync(join(dir, "tools/substitutions.json"), JSON.stringify({ substitutions: patterns.map(rule), denylist: [] }));
    rules("Task tool");
    const scratch = join(root, "tmp");
    mkdirSync(scratch);
    const run = (...args) =>
      spawnSync(process.execPath, [join(dir, "tools/sync.mjs"), ...args], { encoding: "utf8", env: { ...gitEnv, TMPDIR: scratch } });
    return { lauren, matt, run, rules, scratch };
  }

  test("each component syncs from its own remote and sees the other's files", () => {
    const { lauren, matt, run, scratch } = setup();
    for (const [component, sha] of [["pstack", lauren.sha], ["matt", matt.sha]]) {
      const result = run(component, sha, "--dry-run");
      expect(result.stderr).not.toContain("FAIL");
      expect(result.status).toBe(0);
      // Each fixture file comes from one remote, so neither may be listed as
      // port-only: that needs the other component's remote cloned and read.
      expect(result.stdout).not.toContain("a/notes.md");
      expect(result.stdout).not.toContain("grill/notes.md");
    }
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("--check-rules reads every remote, so a rule only the second remote matches passes", () => {
    const { run, rules } = setup();
    const passing = run("--check-rules");
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("ok: each of the 1 substitution rules matches upstream at the pinned SHAs");

    rules("Task tool", "nowhere at all");
    const failing = run("--check-rules");
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("  nowhere at all\n");
  });
});
