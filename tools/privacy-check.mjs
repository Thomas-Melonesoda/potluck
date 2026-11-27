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
//   local-email  a commit author or committer email on a machine-local host (`<name>@<host>.local`),
//                which leaks the account and machine name; use a GitHub noreply address
//   email        an email address in a file or file name, with --staged and --tree, an IP
//                literal or non-ASCII host included; a GitHub noreply address
//                (users.noreply.github.com, noreply@github.com), the SSH remote form
//                git@github.com:owner/name, a reserved example domain (example.com, .net, .org,
//                or a name under .example, .invalid, .test, or .localhost), and a documentation
//                IPv4 address (192.0.2.x, 198.51.100.x, 203.0.113.x) pass. --history leaves
//                this rule out, because the history already holds an upstream author's
//                published address and test fixtures, and the owner never rewrites history
//
// Private rules, which run only where the owner keeps a terms file outside the repository
// ($POTLUCK_PRIVATE_TERMS, else ${XDG_CONFIG_HOME:-~/.config}/potluck/private-terms.txt;
// plugins/pstack/hooks/private-rules.mjs loads it, and the shell hook checks gh PR and issue
// text against the same file):
//   private-term     any line of that file, matched case-insensitively, in content, file names,
//                    and commit author and committer identities
//   vault-file       with a `vault: <dir>` line, a committed file whose name matches a file in
//                    that directory, or content quoting a note title; only distinctive names count
//                    (a non-ASCII name of 4+ characters, or an ASCII name of 16+)
// The terms themselves never appear in the output.
//
// Exit status: 0 clean, 1 findings, 2 usage or git error.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { loadPrivateRules, privateMatches } from "../plugins/pstack/hooks/private-rules.mjs";

export { loadPrivateRules };

const PLACEHOLDER_USERS = new Set(
  ["you", "name", "me", "user", "username", "example", "runner", "someone", "alice", "bob", "jane", "john", "dev", "admin", "shared", "public", "default", "guest"].map((s) => s.toLowerCase()),
);
// Upstream test fixtures use these; one- and two-letter names also pass.
const FIXTURE_USERS = new Set(["oscar"]);
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})([A-Za-z0-9._-]+)/g;
// Split so this file does not trip its own rule.
const VAULT_NAME = new RegExp(["Main", "Vault"].join(""), "i");

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    process.stderr.write(`tools/privacy-check.mjs: git ${args.join(" ")} failed\n${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
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
  found.push(...privateMatches(line, rules));
  return found;
}

// Letters and digits in any script, so a non-ASCII host is read in full; the host may be an
// IP literal in brackets ([192.0.2.1], [IPv6:...]), or end in a number, as an IPv4 address does.
const EMAIL = /([\p{L}\p{N}._%+-]+)@(\[(?:IPv6:[\dA-Fa-f:.]+|\d{1,3}(?:\.\d{1,3}){3})\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:\p{L}{2,}|\d{1,3}))(?![\p{L}\p{N}_-])/gu;
const PUBLIC_EMAIL_DOMAIN = /^(?:users\.noreply\.github\.com|(?:[\w-]+\.)*example\.(?:com|net|org)|(?:[\w-]+\.)*(?:example|invalid|test|localhost))$/i;
// The IPv4 blocks reserved for documentation (RFC 5737), the IP form of example.com.
const DOC_IP = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/;

function isPublicAddress(local, host, after) {
  if (host.startsWith("[")) return false;
  if (/^[\d.]+$/.test(host)) {
    const ip = host.split(".");
    // A version such as react@18.3.1 is not an address.
    if (ip.length !== 4 || ip.some((n) => Number(n) > 255)) return true;
    return DOC_IP.test(host);
  }
  if (/^github\.com$/i.test(host)) return /^noreply$/i.test(local) || (/^git$/i.test(local) && /^[:/]/.test(after));
  return PUBLIC_EMAIL_DOMAIN.test(host);
}

// Whether a line holds an email address other than a GitHub noreply address, the SSH remote
// form git@github.com:owner/name, or an example domain or documentation IP.
export function checkEmail(line) {
  return [...line.matchAll(EMAIL)].some((m) => !isPublicAddress(m[1], m[2], line.slice(m.index + m[0].length))) ? ["email"] : [];
}

export function checkIdentity(ident, rules) {
  const found = [];
  if (/@(?:localhost|[^>\s]*\.(?:local|lan|localdomain|home|internal))>?\s*$/i.test(ident)) found.push("local-email");
  if (privateMatches(ident, { ...rules, vaultTitles: [] }).length) found.push("private-term");
  return found;
}

function scanText(where, text, rules, out) {
  if (text.includes("\0")) return;
  text.split("\n").forEach((line, i) => {
    for (const rule of [...checkLine(line, rules), ...checkEmail(line)]) out.push(`${where}:${i + 1}: ${rule}`);
  });
}

function stagedFindings(cwd, rules) {
  const out = [];
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], cwd).split("\0").filter(Boolean);
  for (const path of names) {
    for (const rule of checkPath(path, rules)) out.push(`${path}: ${rule}`);
    for (const rule of [...checkLine(path, rules), ...checkEmail(path)]) out.push(`${path}: ${rule} (in the file name)`);
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
    for (const rule of [...checkLine(path, rules), ...checkEmail(path)]) out.push(`${path}: ${rule} (in the file name)`);
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
