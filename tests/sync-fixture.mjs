// potluck: a throwaway port and upstream repositories for exercising the
// tools/sync.mjs CLI end to end. Not a test file; tests import it.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIMES } from "../tools/runtimes.mjs";

const tools = join(import.meta.dir, "../tools");
export const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const roots = [];
export const cleanUp = () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));

export function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "potluck-sync-"));
  roots.push(root);
  return root;
}

// A one-commit upstream repository holding `files`.
export function upstreamRepo(root, name, files) {
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

// A port tree with the sync tools, the given upstream.json and forks.json,
// substitution `patterns` that each rewrite to "Agent tool", and local `files`
// under plugins/pstack/skills.
export function port(root, { upstream, forks = {}, patterns = [], denylist = [], files = {} }) {
  const dir = join(root, "port");
  for (const file of ["sync.mjs", "generate.mjs", "plugin.mjs", "runtimes.mjs", "validate-skills.mjs"]) {
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
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, "plugins/pstack/skills", path, ".."), { recursive: true });
    writeFileSync(join(dir, "plugins/pstack/skills", path), text);
  }
  const write = (name, value) => writeFileSync(join(dir, "tools", name), JSON.stringify(value, null, 2) + "\n");
  write("upstream.json", upstream);
  write("forks.json", forks);
  const rules = (...ps) =>
    write("substitutions.json", { substitutions: ps.map((pattern) => ({ pattern, replacement: "Agent tool", rationale: "fixture" })), denylist });
  rules(...patterns);
  const scratch = join(root, "tmp");
  mkdirSync(scratch, { recursive: true });
  const run = (...args) =>
    spawnSync(process.execPath, [join(dir, "tools/sync.mjs"), ...args], { encoding: "utf8", env: { ...gitEnv, TMPDIR: scratch } });
  const read = (path) => readFileSync(join(dir, path), "utf8");
  return { dir, scratch, run, rules, read };
}
