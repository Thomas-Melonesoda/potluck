#!/usr/bin/env node
// Block personal content from entering this public repository.
//
//   node tools/privacy-check.mjs --staged     what the next commit would add (pre-commit hook)
//   node tools/privacy-check.mjs --tree       every tracked file at HEAD plus the working copy
//   node tools/privacy-check.mjs --history    every line any commit on any ref ever added
//
// Public rules, which run everywhere including CI:
//   home-path    a home directory with a real-looking user name (/Users/<name>, /home/<name>,
//                C:\Users\<name>); placeholder names such as `you` or `name` pass
//   vault-name   the name of a personal notes vault
//   env-file     a committed .env or .env.* file (.env.example passes)
//   local-json   a committed *.local.json file
//   local-email  a commit author or committer email on a machine-local host (name@host.local),
//                which leaks the account and machine name; use a GitHub noreply address
//
// Private rules, which run only where the owner keeps a terms file outside the repository
// ($POTLUCK_PRIVATE_TERMS, else ${XDG_CONFIG_HOME:-~/.config}/potluck/private-terms.txt):
//   private-term     any line of that file, matched case-insensitively, in content, file names,
//                    and commit author and committer identities
//   vault-file       with a `vault: <dir>` line, a committed file whose name matches a file in
//                    that directory, or content quoting a note title; only distinctive names count
//                    (a non-ASCII name of 4+ characters, or an ASCII name of 16+)
// The terms themselves never appear in the output.
//
// Exit status: 0 clean, 1 findings, 2 usage or git error.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const PLACEHOLDER_USERS = new Set(
  ["you", "name", "me", "user", "username", "example", "runner", "someone", "alice", "bob", "jane", "john", "dev", "admin", "shared", "public", "default", "guest"].map((s) => s.toLowerCase()),
);
// Upstream test fixtures use these; one- and two-letter names also pass.
const FIXTURE_USERS = new Set(["oscar"]);
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})([A-Za-z0-9._-]+)/g;
// Split so this file does not trip its own rule.
const VAULT_NAME = new RegExp(["Main", "Vault"].join(""), "i");
// Generic English note names ("template", "preferences") are not private; a vault name only
// counts when it has a non-ASCII character or is long enough to be distinctive.
const distinctive = (name) => /[^\x00-\x7f]/.test(name) ? [...name].length >= 4 : name.length >= 16;

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    process.stderr.write(`tools/privacy-check.mjs: git ${args.join(" ")} failed\n${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
}

export function loadPrivateRules(env = process.env) {
  const file = env.POTLUCK_PRIVATE_TERMS || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "potluck", "private-terms.txt");
  const rules = { terms: [], vaultFiles: new Set(), vaultTitles: [], source: null };
  if (!existsSync(file)) return rules;
  rules.source = file;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const vault = line.match(/^vault:\s*(.+)$/);
    if (vault) {
      const dir = vault[1].replace(/^~(?=\/|$)/, homedir());
      for (const f of walk(dir)) {
        const stem = basename(f, extname(f));
        if (distinctive(stem)) rules.vaultFiles.add(basename(f).toLowerCase());
        if (extname(f) === ".md" && distinctive(stem)) rules.vaultTitles.push(stem.toLowerCase());
      }
      continue;
    }
    rules.terms.push(line.toLowerCase());
  }
  return rules;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export function checkPath(path, rules) {
  const found = [];
  const name = basename(path);
  if (/^\.env(\..+)?$/.test(name) && name !== ".env.example") found.push("env-file");
  if (name.endsWith(".local.json")) found.push("local-json");
  if (rules.vaultFiles.has(name.toLowerCase())) found.push("vault-file");
  return found;
}

export function checkLine(line, rules) {
  const found = [];
  for (const m of line.matchAll(HOME_PATH)) {
    const user = m[1].replace(/\.+$/, "").toLowerCase();
    if (user.length > 2 && !PLACEHOLDER_USERS.has(user) && !FIXTURE_USERS.has(user)) {
      found.push("home-path");
      break;
    }
  }
  if (VAULT_NAME.test(line)) found.push("vault-name");
  const lower = line.toLowerCase();
  if (rules.terms.some((t) => lower.includes(t))) found.push("private-term");
  if (rules.vaultTitles.some((t) => lower.includes(t))) found.push("vault-file");
  return found;
}

export function checkIdentity(ident, rules) {
  const found = [];
  if (/@(?:localhost|[^>\s]*\.(?:local|lan|localdomain|home|internal))>?\s*$/i.test(ident)) found.push("local-email");
  const lower = ident.toLowerCase();
  if (rules.terms.some((t) => lower.includes(t))) found.push("private-term");
  return found;
}

function scanText(where, text, rules, out) {
  if (text.includes("\0")) return;
  text.split("\n").forEach((line, i) => {
    for (const rule of checkLine(line, rules)) out.push(`${where}:${i + 1}: ${rule}`);
  });
}

function stagedFindings(cwd, rules) {
  const out = [];
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], cwd).split("\0").filter(Boolean);
  for (const path of names) {
    for (const rule of checkPath(path, rules)) out.push(`${path}: ${rule}`);
    for (const rule of checkLine(path, rules)) out.push(`${path}: ${rule} (in the file name)`);
    scanText(path, git(["show", `:${path}`], cwd), rules, out);
  }
  for (const role of ["AUTHOR", "COMMITTER"]) {
    const ident = git(["var", `GIT_${role}_IDENT`], cwd).replace(/ \d+ [+-]\d{4}\s*$/, "");
    for (const rule of checkIdentity(ident, rules)) out.push(`commit ${role.toLowerCase()}: ${rule}`);
  }
  return out;
}

function treeFindings(cwd, rules) {
  const out = [];
  for (const path of git(["ls-files", "-z"], cwd).split("\0").filter(Boolean)) {
    for (const rule of checkPath(path, rules)) out.push(`${path}: ${rule}`);
    for (const rule of checkLine(path, rules)) out.push(`${path}: ${rule} (in the file name)`);
    const full = join(cwd, path);
    if (existsSync(full) && statSync(full).isFile()) scanText(path, readFileSync(full, "utf8"), rules, out);
  }
  return out;
}

function historyFindings(cwd, rules) {
  const out = new Set();
  let commit = "";
  let file = "";
  const log = git(["log", "--all", "-p", "--no-ext-diff", "--no-color", "--format=commit %h"], cwd);
  for (const line of log.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice(7);
    } else if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : "";
      if (!file) continue;
      for (const rule of checkPath(file, rules)) out.add(`${commit} ${file}: ${rule}`);
      for (const rule of checkLine(file, rules)) out.add(`${commit} ${file}: ${rule} (in the file name)`);
    } else if (line.startsWith("+") && file) {
      for (const rule of checkLine(line.slice(1), rules)) out.add(`${commit} ${file}: ${rule}`);
    }
  }
  const idents = git(["log", "--all", "--format=%h author %an <%ae>%n%h committer %cn <%ce>"], cwd);
  for (const line of idents.split("\n").filter(Boolean)) {
    const [commit, role, ...rest] = line.split(" ");
    for (const rule of checkIdentity(rest.join(" "), rules)) out.add(`${commit} commit ${role}: ${rule}`);
  }
  return [...out];
}

function main(argv) {
  const mode = argv[0];
  const modes = { "--staged": stagedFindings, "--tree": treeFindings, "--history": historyFindings };
  if (argv.length !== 1 || !modes[mode]) {
    process.stderr.write("usage: node tools/privacy-check.mjs --staged | --tree | --history\n");
    return 2;
  }
  const cwd = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const rules = loadPrivateRules();
  const findings = modes[mode](cwd, rules);
  const scope = rules.source ? "public and private rules" : "public rules only (no private terms file)";
  if (findings.length === 0) {
    process.stdout.write(`ok: privacy check ${mode.slice(2)} clean, ${scope}\n`);
    return 0;
  }
  process.stderr.write(`privacy check ${mode.slice(2)} found ${findings.length} problem(s), ${scope}:\n`);
  for (const f of findings) process.stderr.write(`  ${f}\n`);
  process.stderr.write(
    "Remove the personal content, or replace a home path with a placeholder such as /Users/you.\n" +
      "For a commit identity, set this repository's user.name and user.email (for example a GitHub noreply address).\n",
  );
  return 1;
}

if (import.meta.main ?? process.argv[1]?.endsWith("privacy-check.mjs")) process.exit(main(process.argv.slice(2)));
