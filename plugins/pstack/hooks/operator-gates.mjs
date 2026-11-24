#!/usr/bin/env node
// potluck: the operator's gates before each shell command Claude Code runs
// (stage 5 issue 8). potluck's default lets every command through. When a
// gates file (see skills/poteto-mode/scripts/gates.mjs) sets "foreignRepos":
// "ask", a gh call runs without a prompt only when the command text, as this
// hook reads it, shows one of two things:
//   - a read: a gh subcommand on the READS list, or `gh api` with no method
//     other than GET or HEAD, no fields or --input, and no GraphQL endpoint,
//     or --help (never -h, which some subcommands read as --homepage); or
//   - an owned write: the whole command is one plain gh call (no `&&`, `;`,
//     pipes, redirects, `$`, backticks, globs, or a VAR= prefix), one of the
//     WRITES below or a `gh api` call on repos/<owner>/<name>/..., and every
//     repository it names with --repo or a github.com URL is owned by the gh
//     account or one of its organizations.
// Every other command that runs gh, or may run it through a word the shell
// fills in, a glob, or a script handed to sh -c or eval, asks, with the
// reason. It does not predict where gh sends a write: a write that names no
// repository (`gh pr comment 44 -b hi`) asks even in your own checkout. A
// script file that runs gh is out of its reach. A repository the user's own
// gates file lists in trustRepos counts as owned.
//
// It also keeps the gates files the user's (stage 5 follow-up issue 2), with
// or without a gates file: a shell command that may change ~/.potluck/gates.json
// (or the file it links to) or a .potluck/gates.json, and an Edit, Write,
// MultiEdit, or NotebookEdit on one, is blocked. Reading one, and git add,
// commit, diff, log, or show of the user's own edit, pass.
//
// hooks/git-guardrail.sh runs it on each call the guardrail lets through, and
// hooks.json on each file-editing tool call. It reads the hook's JSON on
// stdin. It prints a PreToolUse "ask" decision, or blocks with exit 2 and the
// reason on stderr, or does nothing. With the argument `codex`, which Codex's
// hooks file passes, an ask blocks too, since Codex rejects "ask".

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadGates, repoRoot, userFile } from "../skills/poteto-mode/scripts/gates.mjs";
import { commands } from "./git-guardrail.mjs";

// gh subcommands that only read from GitHub (pr checkout and repo clone change
// only the local checkout). Anything not listed may write.
const READS = {
  pr: ["view", "list", "status", "diff", "checks", "checkout"],
  issue: ["view", "list", "status"],
  repo: ["view", "list", "clone"],
  run: ["view", "list", "watch"],
  workflow: ["view", "list"],
  release: ["view", "list"],
  search: ["repos", "issues", "prs", "code", "commits"],
  auth: ["status"],
};
const TOP_READS = new Set(["status", "version", "help", "--version"]);
// Writes whose repository --repo or a URL names, so one plain call can pass.
const WRITES = {
  pr: ["comment", "review", "create", "edit", "close", "reopen", "ready", "merge", "revert", "update-branch", "lock", "unlock"],
  issue: ["comment", "create", "edit", "close", "reopen", "lock", "unlock", "pin", "unpin", "delete"],
};
// gh's top-level commands, to spot one that follows a word the shell fills in.
const GROUPS = new Set(["pr", "issue", "api", "repo", "release", "gist", "workflow", "run", "label", "secret", "variable", "ruleset", "project", "cache", "codespace", "extension", "alias", "auth", "search", "browse", "org", "co"]);
// gh api's flags: true for those that take a value.
const API_SHORT = { i: false, X: true, f: true, F: true, H: true, q: true, t: true, p: true };
const API_LONG = { include: false, paginate: false, slurp: false, silent: false, verbose: false, method: true, "raw-field": true, field: true, header: true, input: true, jq: true, template: true, hostname: true, cache: true, preview: true };
const API_FIELDS = new Set(["f", "F", "raw-field", "field", "input"]);
// Long flags that take no value in every WRITES subcommand, so a --repo after
// one is not its value.
const NO_VALUE = new Set(["--fill", "--fill-first", "--fill-verbose", "--draft", "--web", "--squash", "--merge", "--rebase", "--auto", "--admin", "--delete-branch", "--approve", "--request-changes", "--edit-last", "--yes"]);
// Commands that never run their words, so a gh in their text is not a call.
const QUIET = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg"]);
const QUIET_GIT = new Set(["commit", "tag", "log", "grep", "show"]);
const WRAPPERS = /(^|\/)(?:command|sudo|env|time|nohup|exec|builtin|nice|timeout|stdbuf|xargs|parallel|watch|eval|then|do|else|elif|if|while|until|!|\{)$/;
const OPAQUE = /[$`]/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REPO = /^(?:(?:https?:\/\/)?(?:[\w-]+\.)*github\.com\/)?([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const URL = /^https?:\/\/(?:[\w-]+\.)*github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/is;

// gh api's arguments as gh reads them, short-flag runs (-iX POST) included.
function parseApi(args) {
  const api = { method: null, fields: false, host: false, unknown: null, positional: [] };
  const set = (name, value) => {
    if (name === "X" || name === "method") api.method = value.toUpperCase();
    if (API_FIELDS.has(name)) api.fields = true;
    if (name === "hostname") api.host = true;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      api.positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [name, ...value] = a.slice(2).split("=");
      if (!(name in API_LONG)) api.unknown = a;
      else if (API_LONG[name]) set(name, value.length ? value.join("=") : (args[++i] ?? ""));
    } else if (a.length > 1 && a.startsWith("-")) {
      for (let k = 1; k < a.length; k++) {
        if (!(a[k] in API_SHORT)) {
          api.unknown = a;
          break;
        }
        if (API_SHORT[a[k]]) {
          set(a[k], a.slice(k + 1).replace(/^=/, "") || (args[++i] ?? ""));
          break;
        }
      }
    } else api.positional.push(a);
  }
  return api;
}

// Whether a gh call (its arguments after gh) only reads.
function isRead(args) {
  // Only --help: some subcommands read -h as --homepage or --hostname.
  const help = args.indexOf("--help");
  const before = args.slice(0, help);
  if (help >= 0 && !before.some((a) => a === "--" || OPAQUE.test(a)) && !(before.at(-1) ?? "").startsWith("-")) return true;
  const [group, sub] = args;
  if (group === undefined || TOP_READS.has(group)) return true;
  if (group === "api") {
    const api = parseApi(args.slice(1));
    const method = api.method ?? "GET";
    return !args.some((a) => OPAQUE.test(a)) && !api.unknown && !api.fields && (method === "GET" || method === "HEAD") && api.positional.length === 1 && !/graphql/i.test(api.positional[0]);
  }
  return READS[group]?.includes(sub) ?? false;
}

const callName = ([group, sub]) => `\`gh ${group === "api" || sub === undefined || sub.startsWith("-") ? group : `${group} ${sub}`}\``;

// For one plain gh write: the owners it names, or why it asks.
function ownedWrite(args) {
  const what = callName(args);
  const [group, sub] = args;
  if (group === "api") {
    const api = parseApi(args.slice(1));
    if (api.unknown || api.host || api.positional.length !== 1) return { why: `${what} uses a flag or form this check does not read` };
    const endpoint = api.positional[0];
    const m = /^\/?repos\/([\w-]+)\/([\w.-]+)(?:[/?]|$)/.exec(endpoint);
    if (!m || /(^|\/)\.\.?(\/|$)|[%\\]/.test(endpoint)) return { why: `${what} calls ${endpoint}, not a repos/<owner>/<name>/... path on github.com, and this check cannot tell which repository that reaches` };
    return { what, repos: [`${m[1]}/${m[2]}`] };
  }
  if (!WRITES[group]?.includes(sub)) return { why: `${what} is neither a read nor a write this check can place` };
  const rest = args.slice(2);
  const repos = [];
  let named = URL.test(rest[0] ?? "");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = a === "--repo" || a === "-R";
    let repo;
    if (next) repo = rest[i + 1] ?? "";
    else if (a.startsWith("--repo=")) repo = a.slice(7);
    else if (/^-R./.test(a)) repo = a.slice(2).replace(/^=/, "");
    else if (/^-[A-Za-z]+R/.test(a)) return { why: `${what} gives --repo in a run of short flags (${a}), which this check does not read` };
    else if (/^https?:\/\/|github\.com/i.test(a)) {
      const url = URL.exec(a);
      if (!url) return { why: `${what} names ${a}, which is not a github.com repository this check can read` };
      repos.push(`${url[1]}/${url[2]}`);
      continue;
    } else continue;
    // A flag before it that takes a value would take this --repo as that value.
    const prev = i > 0 ? rest[i - 1] : sub;
    if (prev.startsWith("-") && !prev.includes("=") && !NO_VALUE.has(prev)) return { why: `${what} gives --repo right after ${prev}, which may take it as its value` };
    const owner = REPO.exec(repo);
    if (!owner) return { why: `${what} names ${repo}, which is not a github.com repository this check can read` };
    repos.push(`${owner[1]}/${owner[2]}`);
    named = true;
    if (next) i++;
  }
  if (!named) return { why: `${what} names no repository with --repo or a URL, so gh would pick one from the checkout, which this check does not predict` };
  return { what, repos };
}

// The words of a command that is one simple command with every word literal:
// plain characters, single quotes, and double quotes without $, backticks, or
// backslashes. Null for anything the shell would expand, chain, or redirect.
function literal(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === " " || c === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close < 0) return null;
      const text = command.slice(i + 1, close);
      if (c === '"' && /[$`\\]/.test(text)) return null;
      word = (word ?? "") + text;
      i = close;
    } else if (/[\w@%+=:,./-]/.test(c)) word = (word ?? "") + c;
    else return null;
  }
  if (word !== null) words.push(word);
  return words;
}

// Whether a word the shell globs could expand to gh, as g[h] or g? can.
function globsToGh(word) {
  const seg = word.split("/").pop();
  if (!/[[*?]/.test(seg) || /^\*+$/.test(seg)) return false;
  let src = "";
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    const close = c === "[" ? seg.indexOf("]", k + 2) : -1;
    if (c === "*") src += ".*";
    else if (c === "?") src += ".";
    else if (close > 0) {
      src += `[${seg.slice(k + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      k = close;
    } else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${src}$`).test("gh");
  } catch {
    return true;
  }
}

// Why a command that is not one plain gh call may write with gh, or null when
// every gh call in it is a read. Words that may hold a script (sh -c '...',
// eval '...') are read as commands too.
function scan(text, depth = 0) {
  if (depth > 4) return "nests commands too deeply to read";
  for (const words of commands(text)) {
    let head = 0;
    while (head < words.length && ASSIGN.test(words[head])) head++;
    if (QUIET.has(words[head]) || (words[head] === "git" && QUIET_GIT.has(words[head + 1]))) continue;
    for (let k = head; k < words.length; k++) {
      const w = words[k];
      const prev = words[k - 1] ?? "";
      if (/(^|\/)gh$/.test(w)) {
        const args = words.slice(k + 1);
        const fed = words.slice(head, k).some((x) => /(^|\/)(?:xargs|parallel)$/.test(x));
        if (fed || !isRead(args)) return `${callName(args)} is not a read, and the command is not one plain gh call naming an owned repository with --repo or a URL`;
        break;
      }
      if (globsToGh(w)) return `this command runs ${w}, a pattern the shell may expand to gh`;
      const runs = (k === head && depth === 0) || WRAPPERS.test(prev) || GROUPS.has(words[k + 1] ?? "") || (/^-[a-z]*c[a-z]*$/.test(prev) && words.slice(head, k).some((x) => /(^|\/)(?:ba|z|da|k)?sh$/.test(x)));
      if (OPAQUE.test(w) && runs) return `this command may run gh through ${w}, which the shell fills in at run time`;
      if (/\s/.test(w) && w !== text) {
        const inner = scan(w, depth + 1);
        if (inner) return inner;
      }
    }
  }
  return null;
}

// What to check about a command: null when it runs no gh call that may write,
// { why } to ask, or { what, owners } for one plain write to named repositories.
export function classify(command) {
  try {
    const words = literal(command.trim());
    if (words?.[0] === "gh") return isRead(words.slice(1)) ? null : ownedWrite(words.slice(1));
    const why = scan(command);
    return why && { why };
  } catch {
    return { why: "this command could not be read, and it may run gh" };
  }
}

const gh = (cwd, args) => JSON.parse(execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }));

// The reason to ask before this command, or null to let it run.
export function check(command, cwd) {
  const found = classify(command);
  if (!found) return null;
  let gates;
  try {
    gates = loadGates({ root: repoRoot(cwd) });
  } catch (error) {
    return `potluck: the operator's gates could not be read (${error.message}), so this gh command needs the user's yes until the file is fixed.`;
  }
  if (gates.foreignRepos !== "ask") return null;
  const ask = (why) => `potluck operator's gates (foreignRepos: ask, from ${gates.from.foreignRepos}): ${why}, so it needs the user's yes.`;
  if (found.why) return ask(found.why);
  let mine;
  try {
    const login = gh(cwd, ["api", "user"]).login;
    const orgs = gh(cwd, ["api", "--paginate", "--slurp", "user/orgs"]).flat().map((o) => o.login);
    mine = new Set([login, ...orgs].map((name) => name.toLowerCase()));
  } catch (error) {
    return ask(`${found.what} writes to a repository, and the gh account could not be read (${String(error.stderr || error.message).trim().split("\n")[0]})`);
  }
  const trusted = new Set(gates.trustRepos ?? []);
  const foreign = found.repos.map((r) => r.toLowerCase()).find((r) => !mine.has(r.split("/")[0]) && !trusted.has(r.split("/")[0]) && !trusted.has(r));
  return foreign ? ask(`${found.what} writes to a repository owned by ${foreign.split("/")[0]}, which neither the gh account nor its organizations own, and which the user's trustRepos does not list`) : null;
}

// The gates files: any .potluck/gates.json, and the file ~/.potluck/gates.json
// links to.
function gatesTarget() {
  try {
    return realpathSync(userFile());
  } catch {
    return null;
  }
}
const LOCKED = "potluck: only the user changes a gates file (the operator's gates), so this agent call is blocked. Suggest the change to the user instead; they edit the file themselves.";
function isGatesFile(path, cwd) {
  const full = isAbsolute(path) ? path : join(cwd, path);
  if (/(^|\/)\.potluck\/gates\.json$/.test(full)) return true;
  const target = gatesTarget();
  if (!target) return false;
  try {
    return realpathSync(full) === target;
  } catch {
    return full === target;
  }
}

// Commands that only read what they name, and git subcommands that do not
// change the working tree. Anything else that names a gates file or folder
// counts as a change, so a command this list does not know is blocked.
const READERS = new Set(["cd", "pushd", "popd", "cat", "less", "more", "head", "tail", "bat", "jq", "grep", "egrep", "fgrep", "rg", "wc", "ls", "tree", "du", "stat", "file", "diff", "cmp", "readlink", "realpath", "md5", "shasum", "sha256sum", "test", "[", "echo", "printf", "pwd", "basename", "dirname", "mkdir"]);
const GIT_READERS = new Set(["add", "commit", "diff", "log", "show", "status", "blame", "ls-files", "ls-tree", "grep", "rev-parse", "cat-file"]);
// git's options before the subcommand that take a value.
const GIT_VALUED = /^(-C|-c|--git-dir|--work-tree|--namespace)$/;

// Whether a command with these words only reads; `touches` says whether a
// word names a gates file or a folder holding one.
function reads(head, args, touches) {
  // A few readers have an option that writes a file or runs a program: tree
  // and less -o, git and diff --output, jq -i, rg --pre, git grep -O.
  const writing = { tree: /^-[A-Za-z]*o/, less: /^-[A-Za-z]*[oO]/, jq: /^(-i|--in-place)/, rg: /^--pre(=|$)/, git: /^(-O|--open-files-in-pager)/ };
  if (args.some((a) => /^--output(-file)?(=|$)/.test(a) || writing[head]?.test(a))) return false;
  if (READERS.has(head)) return true;
  // find reads unless it deletes, writes a file, or runs a command that is not a reader.
  if (head === "find") return !args.some((a, i) => /^-(delete|fprint|fprint0|fprintf|fls)$/.test(a) || (/^-(exec|execdir|ok|okdir)$/.test(a) && !READERS.has((args[i + 1] ?? "").replace(/^.*\//, ""))));
  if (head === "git") {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i += GIT_VALUED.test(args[i]) ? 2 : 1;
    return GIT_READERS.has(args[i]);
  }
  // Copying out of a gates folder reads it. The destination is the last
  // operand, but an option after it can take a value, so no word after the
  // first operand may name a gates path.
  if (head === "cp" || head === "rsync") {
    const operands = args.filter((a) => !a.startsWith("-"));
    const writes = head === "cp" ? /^(-[A-Za-z]*t|--target-directory(=.*)?)$/ : /^(--delete.*|--remove-source-files)$/;
    return operands.length > 1 && !operands.slice(1).some(touches) && !args.some((a) => writes.test(a) || (/^--[\w-]+=/.test(a) && touches(a.slice(a.indexOf("=") + 1))));
  }
  // An archive listed or created elsewhere reads; one extracted may write.
  if (head === "tar") {
    if (args.some((a, i) => /^--(extract|get|delete|append|update|remove-files)$/.test(a) || /^-[A-Za-z]*[xrud]/.test(a) || (i === 0 && /^[A-Za-z]*[xrud]/.test(a)))) return false;
    const file = args.findIndex((a, i) => /^--file$/.test(a) || /^-[A-Za-z]*f$/.test(a) || (i === 0 && /^[A-Za-z]*f$/.test(a)));
    return !(file >= 0 && touches(args[file + 1] ?? "")) && !args.some((a) => /^--file=/.test(a) && touches(a.slice(7)));
  }
  if (head === "unzip") return args.some((a) => /^-[A-Za-z]*[lvZ]/.test(a));
  // zip reads what it packs, unless it moves the files in (-m) or writes its
  // archive elsewhere (-O); its archive is the first operand.
  if (head === "zip") return !args.some((a) => /^-[A-Za-z]*[mO]/.test(a) || /^--(move|output-file|out)/.test(a)) && !touches(args.find((a) => !a.startsWith("-")) ?? "");
  return false;
}

// Whether a shell command may change a gates file: it names one, the file the
// user's links to, or a folder holding one, in a command that does not only
// read, or redirects output to one. After a cd, a bare gates.json counts, and
// after a cd into a gates folder (or one the hook cannot read) only reads pass.
export function touchesGates(command, cwd) {
  const target = gatesTarget();
  if (!/gates\.json|\.potluck/.test(command) && !(target && command.includes(target))) return false;
  const home = process.env.HOME ?? "";
  const all = commands(command);
  const expand = (w) => (w === "~" || w.startsWith("~/") ? join(home, w.slice(1)) : w);
  // A folder that holds a gates file: a .potluck folder, or one above the
  // file the user's links to.
  const folder = (w) => {
    const path = expand(w);
    const full = (isAbsolute(path) ? path : join(cwd, path)).replace(/\/+$/, "");
    return /(^|\/)\.potluck$/.test(full) || Boolean(target && target.startsWith(`${full}/`));
  };
  const cds = all.map((words) => words.filter((w) => !ASSIGN.test(w))).filter((w) => /^(cd|pushd|popd)$/.test(w[0] ?? ""));
  const moved = cds.length > 0;
  const intoGates = cds.some((w) => {
    const to = w.slice(1).find((a) => !a.startsWith("-") || a === "-");
    return to === undefined || to === "-" || /[$`*?[{]/.test(to) || folder(to.replace(/^["']|["']$/g, ""));
  });
  const named = (w) => {
    const path = expand(w);
    return w.includes(".potluck/gates.json") || (target && w.includes(target)) || (moved && /^(\.\/)?gates\.json$/.test(w)) || (/gates\.json$/.test(w) && isGatesFile(path, cwd));
  };
  // After a cd into a gates folder, a relative path may be inside it.
  const touches = (w) => named(w) || folder(w) || (intoGates && !isAbsolute(expand(w))) || (/^--(directory|file|target-directory|output|output-file)=/.test(w) && touches(w.slice(w.indexOf("=") + 1)));
  // commands() drops redirect targets, so read them here. One that is not a
  // plain path (a variable, a substitution) may be a gates file.
  for (const [, to] of command.matchAll(/(?:^|[^<>&])(?:\d*|&)(?:<>|>&|>>?\|?)\s*([^\s;|&<>()]+|(?=\())/g)) {
    if (/^\d?-?$/.test(to) || /^&\d?-?$/.test(to) || to === "/dev/null") continue;
    if (!to || /[$`*?[{]/.test(to) || touches(to.replace(/["']/g, ""))) return true;
  }
  for (const words of all) {
    let i = 0;
    while (i < words.length && (ASSIGN.test(words[i]) || WRAPPERS.test(words[i]))) i++;
    const head = (words[i] ?? "").replace(/^.*\//, "");
    if (!intoGates && !words.some(touches)) continue;
    if (!reads(head, words.slice(i + 1), touches)) return true;
  }
  return false;
}

export function main(stdin, argv = []) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return 0;
  }
  const cwd = input?.cwd || process.cwd();
  const block = (reason) => {
    process.stderr.write(`${reason}\n`);
    return 2;
  };
  const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (typeof file === "string") return isGatesFile(file, cwd) ? block(LOCKED) : 0;
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return 0;
  try {
    if (touchesGates(command, cwd)) return block(LOCKED);
  } catch {
    if (/gates\.json/.test(command)) return block(LOCKED);
  }
  let reason;
  try {
    reason = check(command, input.cwd || process.cwd());
  } catch {
    reason = /gh|[[*?$`]/.test(command) ? "potluck operator's gates: this command could not be read, and it may run gh, so it needs the user's yes." : null;
  }
  if (!reason) return 0;
  if (argv.includes("codex")) return block(`${reason} Codex cannot ask before a command runs, so ask the user in the conversation, and let them run it.`);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } })}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("operator-gates.mjs")) process.exitCode = main(readFileSync(0, "utf8"), process.argv.slice(2));
