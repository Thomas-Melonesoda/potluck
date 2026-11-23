#!/usr/bin/env node
// potluck: the operator's gates, settings stricter than potluck's defaults
// (stage 5 design answers). potluck's defaults stay Lauren Tan's way; a gates
// file can only make them stricter. Two files apply, and for each gate the
// stricter value wins:
//   ~/.potluck/gates.json   the user's own, for every repository
//   .potluck/gates.json     one repository's, at its root
// Each is a JSON object with any of these keys:
//   "noCI": "wait"            a PR with no CI result (the repository has no CI,
//                             or its CI does not run on pull requests) stops at
//                             merge-ready, and the merge gate reports it held
//                             for a person to merge (default "merge")
//   "foreignRepos": "ask"     a gh command that writes to a repository the gh
//                             account and its organizations do not own stops
//                             for the user's yes (default "allow")
//   "askFirst": ["<action>"]  actions the agent asks the user about first
// An unknown key or value fails, so a typo never drops a gate quietly.
//
//   node gates.mjs [--root <dir>]
//
// prints the gates in force for the repository at <dir> (default: the one the
// current directory is in), one per line, for poteto-mode to read when a run
// starts. Exit 1 when a gates file cannot be read.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const REPO_FILE = ".potluck/gates.json";
export const userFile = () => join(homedir(), ".potluck", "gates.json");

// Each gate's values: potluck's default first, then stricter ones.
export const LEVELS = { noCI: ["merge", "wait"], foreignRepos: ["allow", "ask"] };

const SAYS = {
  noCI: {
    wait: "A PR with no CI result (the repository has no CI, or its CI does not run on pull requests) stops at merge-ready: the merge gate reports it held, and a person merges it.",
  },
  foreignRepos: {
    ask: "A gh command that writes to a repository the gh account and its organizations do not own (a comment, review, issue, or pull request, an edit or state change to one, or a write through gh api) needs the user's yes first. On Claude Code, potluck's hook asks before every gh call it cannot prove is a read or a write to an owned repository, so a write that names no repository asks too; to write to an owned repository without a prompt, run gh alone, every word literal, and name the repository (gh pr comment 44 --repo owner/name --body ...). Elsewhere, ask before running a write to a repository the account does not own.",
  },
};

export function parseGates(text, source) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON: ${error.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: must be a JSON object`);
  // JSON.parse keeps a repeated key's last value, which could drop a gate.
  // The file is one flat object, so every quoted string before a colon is a
  // key, compared as JSON decodes it, escapes included.
  const keys = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const twice = keys.find((key, i) => keys.indexOf(key) !== i);
  if (twice !== undefined) throw new Error(`${source}: key ${JSON.stringify(twice)} appears more than once`);
  for (const [key, value] of Object.entries(raw)) {
    if (key === "askFirst") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${source}: askFirst must be a list of non-empty strings`);
    } else if (Object.hasOwn(LEVELS, key)) {
      if (!LEVELS[key].includes(value)) throw new Error(`${source}: ${key} must be ${LEVELS[key].map((v) => JSON.stringify(v)).join(" or ")}, not ${JSON.stringify(value)}`);
    } else {
      throw new Error(`${source}: unknown key ${JSON.stringify(key)}; the keys are ${[...Object.keys(LEVELS), "askFirst"].join(", ")}`);
    }
  }
  return raw;
}

// The gates in force: each gate's strictest value across the layers, with the
// file that set it in `from`, and every askFirst item once.
export function strictest(layers) {
  const gates = { from: {}, askFirst: [] };
  for (const [key, values] of Object.entries(LEVELS)) gates[key] = values[0];
  for (const { source, gates: layer } of layers) {
    for (const [key, values] of Object.entries(LEVELS)) {
      if (layer[key] !== undefined && values.indexOf(layer[key]) > values.indexOf(gates[key])) {
        gates[key] = layer[key];
        gates.from[key] = source;
      }
    }
    for (const item of layer.askFirst ?? []) if (!gates.askFirst.includes(item.trim())) gates.askFirst.push(item.trim());
  }
  return gates;
}

// The user's file and the repository's file at `root`. A missing file adds
// nothing; one that cannot be parsed throws.
export function loadGates({ root, user = userFile() } = {}) {
  const paths = [...new Set([user, root && join(root, REPO_FILE)].filter(Boolean))];
  return strictest(paths.filter((path) => existsSync(path)).map((path) => ({ source: path, gates: parseGates(readFileSync(path, "utf8"), path) })));
}

export function describe(gates) {
  const lines = Object.keys(LEVELS)
    .filter((key) => gates.from[key])
    .map((key) => `- ${key}: ${gates[key]} (${gates.from[key]}). ${SAYS[key][gates[key]]}`);
  for (const item of gates.askFirst) lines.push(`- Ask the user first: ${item}`);
  if (!lines.length) return ["No operator's gates: potluck's defaults apply."];
  return ["The operator's gates, stricter than potluck's defaults:", ...lines];
}

export function repoRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

export function main(argv) {
  let root;
  try {
    ({ root } = parseArgs({ args: argv, options: { root: { type: "string" } } }).values);
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: gates.mjs [--root <dir>]\n`);
    return 2;
  }
  try {
    process.stdout.write(`${describe(loadGates({ root: root ?? repoRoot(process.cwd()) })).join("\n")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// Only when run as this file, not when a script whose name ends the same, such
// as hooks/operator-gates.mjs, imports it.
if (/(^|[\\/])gates\.mjs$/.test(process.argv[1] ?? "")) process.exitCode = main(process.argv.slice(2));
