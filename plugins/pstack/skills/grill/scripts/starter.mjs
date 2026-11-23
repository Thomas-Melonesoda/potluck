#!/usr/bin/env node
// potluck: the new-project starter (stage 5 issue 10), which grill runs when
// it is done. It writes each of these the project is missing and leaves any
// file that is already there alone:
//
//   .github/workflows/ci.yml  the project's check on every pull request and on main
//   .githooks/pre-commit      the quality floor and a secret scan before each commit
//   AGENTS.md                 a skeleton of the project's instructions for agents
//   CLAUDE.md                 `@AGENTS.md`, so Claude Code reads the same file
//
// Then, in this clone only, it copies the floor guard from
// constraint-driven-development into the git folder (potluck/floor-guard.mjs,
// refreshed on every run) and points git at the hook, unless core.hooksPath
// already names another folder. The guard stays out of the tree because its
// own patterns name the forms it refuses, so committing it would trip it.
//
//   node starter.mjs [--root <dir>] [--name <project>] [--check <command>]
//
// Without --check, CI's check step fails with a message to put the project's
// one check command there, so CI never shows green for checking nothing.
// Exit 0 done, 2 usage.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { guardSource } from "../../poteto-mode/scripts/merge-gate.mjs";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "../starter");
export const NO_CHECK = `echo "No check command yet: put the project's one check command here and in AGENTS.md." >&2; exit 1`;

// The files the starter writes into a project, as { path, text, mode }.
export function starterFiles({ name, check }) {
  const template = (file) => readFileSync(join(TEMPLATES, file), "utf8");
  return [
    { path: ".github/workflows/ci.yml", text: template("ci.yml").replace("CHECK_COMMAND", check ?? NO_CHECK) },
    { path: ".githooks/pre-commit", text: template("pre-commit"), mode: 0o755 },
    { path: "AGENTS.md", text: template("AGENTS.template.md").replace("PROJECT_NAME", name).replace("CHECK_COMMAND", check ? `\`${check}\`` : "to confirm") },
    { path: "CLAUDE.md", text: "@AGENTS.md\n" },
  ];
}

// Writes what is missing under `root` and returns one line per file or setting.
export function start(root, { name = basename(root), check } = {}) {
  const lines = [];
  for (const file of starterFiles({ name, check })) {
    const at = join(root, file.path);
    if (existsSync(at)) {
      lines.push(`kept ${file.path}, which was already there`);
      continue;
    }
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.text);
    if (file.mode) chmodSync(at, file.mode);
    lines.push(`wrote ${file.path}`);
  }
  const claude = join(root, "CLAUDE.md");
  if (!readFileSync(claude, "utf8").includes("@AGENTS.md")) lines.push("note: CLAUDE.md does not read AGENTS.md; add a line `@AGENTS.md` to it");

  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") {
    lines.push("note: not a git repository, so the hook is not enabled; run `git init`, then the starter again");
    return lines;
  }
  const common = resolve(root, git("rev-parse", "--git-common-dir").stdout.trim());
  mkdirSync(join(common, "potluck"), { recursive: true });
  writeFileSync(join(common, "potluck/floor-guard.mjs"), guardSource());
  lines.push("wrote the floor guard into this clone's git folder (potluck/floor-guard.mjs)");
  const hooks = git("config", "--get", "core.hooksPath").stdout.trim();
  if (!hooks) {
    git("config", "--local", "core.hooksPath", ".githooks");
    lines.push("set core.hooksPath to .githooks");
  } else if (hooks !== ".githooks") {
    lines.push(`note: core.hooksPath is ${hooks}, so .githooks/pre-commit does not run; call it from that folder's pre-commit`);
  }
  return lines;
}

export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { root: { type: "string" }, name: { type: "string" }, check: { type: "string" } } }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (values.check !== undefined && (!values.check.trim() || values.check.includes("\n"))) return process.stderr.write("--check must be one command on one line\n"), 2;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim();
  const root = resolve(values.root ?? (top || "."));
  if (!existsSync(root)) return process.stderr.write(`${root} does not exist\n`), 2;
  for (const line of start(root, { name: values.name, check: values.check })) process.stdout.write(`${line}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
