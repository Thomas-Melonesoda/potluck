#!/usr/bin/env node
// potluck: the operator's gates before each shell command Claude Code runs
// (stage 5 issue 8). potluck's default lets every command through. When a
// gates file (see skills/poteto-mode/scripts/gates.mjs) sets "foreignRepos":
// "ask", a gh command that writes to a repository that neither the gh account
// nor one of its organizations owns gets Claude Code's permission prompt, with
// the reason, so the user decides. The user's own repositories pass. Writes:
//   - gh pr comment, review, create, edit, close, reopen, ready, merge, revert,
//     update-branch, lock, unlock; gh issue comment, create, edit, close,
//     reopen, lock, unlock, pin, unpin, transfer, delete, develop
//   - gh api with a method other than GET or HEAD, or with fields or --input
//     and no method, on a repos/<owner>/<repo> path, and a GraphQL mutation
//     or a GraphQL query read from a file
// The repository is the one a github.com pull or issue URL among the
// arguments names (gh prefers it), else --repo (-R) or GH_REPO, else the one
// gh resolves in the command's directory (`gh repo view`). A repository,
// selector, or endpoint the shell fills in at run time ($VAR, $(...), a
// backtick) cannot be read, so it asks. A GraphQL mutation names no
// repository, so it always asks; so does a write whose owner or account
// cannot be read, and any write while a gates file cannot be parsed.
// Commands inside sh -c, eval, subshells, and if or loop bodies are read as
// the git guardrail reads them. hooks/git-guardrail.sh runs it on each call the
// guardrail lets through. It reads the hook's JSON on stdin, prints a
// PreToolUse "ask" decision or nothing, and exits 0.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadGates, repoRoot } from "../skills/poteto-mode/scripts/gates.mjs";
import { commands, expand } from "./git-guardrail.mjs";

const WRITES = {
  pr: new Set(["comment", "review", "create", "edit", "close", "reopen", "ready", "merge", "revert", "update-branch", "lock", "unlock"]),
  issue: new Set(["comment", "create", "edit", "close", "reopen", "lock", "unlock", "pin", "unpin", "transfer", "delete", "develop"]),
};
const API_VALUES = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);
const FIELDS = /^(?:-[fF]|--(?:raw-)?field|--input)(?:=|$)|^-[fF]./;
const URL = /^https?:\/\/github\.com\/([^/\s]+)\/[^/\s]+\/(?:pull|issues)\/\d+/i;
// A word the shell fills in at run time, which this check cannot read.
const OPAQUE = /[$`]/;
const unread = (what, word) => ({ unreadable: `names its ${what} as ${word}` });

// The owner a repository argument names: OWNER/REPO, HOST/OWNER/REPO, or a URL.
function ownerOf(repo) {
  if (OPAQUE.test(repo)) return unread("repository", repo);
  const parts = repo.replace(/^https?:\/\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length === 3 && !/^github\.com$/i.test(parts[0])) return { foreignHost: parts[0] };
  return parts.length >= 2 ? { owner: parts.at(-2) } : unread("repository", repo);
}

// A flag's value: `-R v`, `--repo v`, `--repo=v`, `-Rv`, or `-R=v`.
const valueOf = (args, short, long) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === short || a === long) return args[i + 1];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
    if (a.startsWith(short) && !a.startsWith("--")) return a.slice(short.length).replace(/^=/, "");
  }
  return undefined;
};

// What a gh call writes and where: null for a read, else { what, owner? }.
// No owner means the repository gh resolves in the command's directory.
export function ghWrite(args, env) {
  const named = valueOf(args, "-R", "--repo") ?? env.GH_REPO;
  if (args[0] === "api") {
    const rest = args.slice(1);
    let endpoint;
    for (let i = 0; i < rest.length; i++) {
      if (API_VALUES.has(rest[i])) i++;
      else if (!rest[i].startsWith("-")) {
        endpoint = rest[i];
        break;
      }
    }
    const method = (valueOf(rest, "-X", "--method") ?? (rest.some((a) => FIELDS.test(a)) ? "POST" : "GET")).toUpperCase();
    if (method === "GET" || method === "HEAD" || !endpoint) return null;
    if (OPAQUE.test(endpoint)) return { what: `\`gh api ${method}\``, ...unread("endpoint", endpoint) };
    const path = endpoint.replace(/^https?:\/\/api\.github\.com/i, "").replace(/^\//, "");
    if (path === "graphql") {
      if (rest.some((a) => /\bmutation\b/.test(a))) return { what: "a GraphQL mutation", always: true };
      return rest.some((a) => /=@/.test(a) || /^--input/.test(a)) ? { what: "a GraphQL query read from a file", always: true } : null;
    }
    const m = /^repos\/([^/]+)\/[^/]+/.exec(path);
    if (!m) return null;
    return { what: `\`gh api ${method} ${path}\``, ...(m[1] === "{owner}" ? (named ? ownerOf(named) : {}) : { owner: m[1] }) };
  }
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo") i++;
    else if (!args[i].startsWith("-")) words.push(args[i]);
  }
  const [group, sub, selector] = words;
  if (!WRITES[group]?.has(sub) || args.some((a) => a === "--help" || a === "-h")) return null;
  const what = `\`gh ${group} ${sub}\``;
  // gh takes the repository from a pull or issue URL over --repo and GH_REPO.
  const url = args.map((a) => URL.exec(a)).find(Boolean);
  if (url) return { what, owner: url[1] };
  // Every write but create names its pull request or issue first.
  if (sub !== "create" && selector !== undefined && OPAQUE.test(selector)) return { what, ...unread("pull request or issue", selector) };
  return { what, ...(named ? ownerOf(named) : {}) };
}

const gh = (cwd, args) => JSON.parse(execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }));

// Every gh write in the command, with the directory and environment it runs in.
export function writes(command, cwd, env = process.env) {
  const found = [];
  let dir = cwd;
  let ghRepo = env.GH_REPO;
  for (const base of commands(command)) {
    if ((base[0] === "cd" || base[0] === "pushd") && base.length <= 2) {
      dir = base[1] && isAbsolute(base[1]) ? base[1] : join(dir, base[1] ?? env.HOME ?? dir);
      continue;
    }
    if (base[0] === "export") ghRepo = base.find((w) => w.startsWith("GH_REPO="))?.slice(8) ?? ghRepo;
    const assigned = base.find((w) => w.startsWith("GH_REPO="))?.slice(8);
    for (const words of expand(base)) {
      // gh may follow a wrapper the guardrail does not know, such as nice, or
      // come from a variable ($GH pr comment).
      const at = words.findIndex((w, i) => /(^|\/)gh$/.test(w) || (OPAQUE.test(w) && ["pr", "issue", "api"].includes(words[i + 1])));
      if (at < 0) continue;
      const write = ghWrite(words.slice(at + 1), { GH_REPO: assigned ?? ghRepo });
      if (write) found.push({ ...write, dir });
    }
  }
  return found;
}

// The reason to ask before this command, or null to let it run.
export function check(command, cwd, env = process.env) {
  const found = writes(command, cwd, env);
  if (!found.length) return null;
  let gates;
  try {
    gates = loadGates({ root: repoRoot(cwd) });
  } catch (error) {
    return `potluck: the operator's gates could not be read (${error.message}), so ${found[0].what} needs the user's yes until the file is fixed.`;
  }
  if (gates.foreignRepos !== "ask") return null;
  const gate = `potluck operator's gates (foreignRepos: ask, from ${gates.from.foreignRepos})`;
  let mine;
  try {
    const login = gh(cwd, ["api", "user"]).login;
    const orgs = gh(cwd, ["api", "--paginate", "--slurp", "user/orgs"]).flat().map((o) => o.login);
    mine = new Set([login, ...orgs].map((name) => name.toLowerCase()));
  } catch (error) {
    return `${gate}: ${found[0].what} writes to a repository, and the gh account could not be read (${String(error.stderr || error.message).trim().split("\n")[0]}), so it needs the user's yes.`;
  }
  for (const write of found) {
    if (write.always) return `${gate}: ${write.what} does not show which repository it writes to, so it needs the user's yes.`;
    if (write.unreadable) return `${gate}: ${write.what} ${write.unreadable}, which this check cannot read, so it needs the user's yes.`;
    if (write.foreignHost) return `${gate}: ${write.what} writes to a repository on ${write.foreignHost}, which this check cannot read, so it needs the user's yes.`;
    let owner = write.owner;
    if (!owner) {
      try {
        owner = gh(write.dir, ["repo", "view", "--json", "owner"]).owner.login;
      } catch {
        return `${gate}: ${write.what} writes to the repository gh resolves in ${write.dir}, which could not be read, so it needs the user's yes.`;
      }
    }
    if (!mine.has(owner.toLowerCase())) return `${gate}: ${write.what} writes to a repository owned by ${owner}, which neither the gh account nor its organizations own, so it needs the user's yes.`;
  }
  return null;
}

export function main(stdin) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return 0;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return 0;
  let reason;
  try {
    reason = check(command, input.cwd || process.cwd());
  } catch {
    // A command this hook cannot read asks only when it may run gh.
    reason = /(^|[^\w-])gh\b/.test(command) ? "potluck operator's gates: this command could not be read, and it may run gh, so it needs the user's yes." : null;
  }
  if (reason) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } })}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("operator-gates.mjs")) process.exitCode = main(readFileSync(0, "utf8"));
