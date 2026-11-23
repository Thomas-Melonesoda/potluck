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
//     or a GraphQL query it cannot read
// Rather than predict which repository gh picks, it checks every one the
// write could reach, and asks when any is not owned: each github.com URL
// among the arguments, each --repo (-R) value, and, without one, each GH_REPO
// value and the repository gh resolves (`gh repo view`) in each directory the
// command starts in or changes to, a cd inside a subshell included. A value
// the shell fills in at run time ($VAR, $(...), a backtick) cannot be read, so
// it asks; so does a write whose account cannot be read, and any write while a
// gates file cannot be parsed. Commands inside sh -c, eval, subshells, braces,
// and if or loop bodies are read as the git guardrail reads them.
// hooks/git-guardrail.sh runs it on each call the guardrail lets through. It
// reads the hook's JSON on stdin, prints a PreToolUse "ask" decision or
// nothing, and exits 0.

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
const URLS = /https?:\/\/github\.com\/([^/\s"'<>]+)\/[^/\s"'<>]+/gi;
// A word the shell fills in at run time, which this check cannot read.
const OPAQUE = /[$`]/;
const UNKNOWN = "an unknown directory";

// What a repository argument names: OWNER/REPO, HOST/OWNER/REPO, or a URL.
function target(repo) {
  const unread = { unreadable: `names its repository as ${repo}, which this check cannot read` };
  if (OPAQUE.test(repo)) return unread;
  const parts = repo.replace(/^https?:\/\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length === 3 && !/^github\.com$/i.test(parts[0])) return { unreadable: `writes to a repository on ${parts[0]}, which this check cannot read` };
  return parts.length >= 2 ? { owner: parts.at(-2) } : unread;
}

// Every value of one flag, as gh's parser reads it: `--long v`, `--long=v`,
// and the short letter alone or at the end of a run (`-R v`, `-sR v`) or with
// its value attached (`-Rv`, `-R=v`, `-dRv`). `skip` collects the indexes of
// values that follow their flag, so they are not read as positional words.
function flagValues(args, letter, long, skip = new Set()) {
  const values = [];
  const short = new RegExp(`^-[A-Za-z]*${letter}(=?)(.*)$`);
  args.forEach((a, i) => {
    if (a === long && i + 1 < args.length) {
      values.push(args[i + 1]);
      skip.add(i + 1);
    } else if (a.startsWith(`${long}=`)) values.push(a.slice(long.length + 1));
    else if (!a.startsWith("--")) {
      const m = short.exec(a);
      if (!m) return;
      if (m[2] || m[1]) values.push(m[2]);
      else if (i + 1 < args.length) {
        values.push(args[i + 1]);
        skip.add(i + 1);
      }
    }
  });
  return values;
}

// The repositories a gh call may write to, or null for a read: { what, owners,
// unreadable, named }. Without a named repository, gh resolves it from
// GH_REPO or the command's directory, which the caller adds.
export function ghWrite(args) {
  const urls = args.flatMap((a) => [...a.matchAll(URLS)].map((m) => m[1]));
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
    const method = (flagValues(rest, "X", "--method").at(-1) ?? (rest.some((a) => FIELDS.test(a)) ? "POST" : "GET")).toUpperCase();
    if (method === "GET" || method === "HEAD" || !endpoint) return null;
    const what = `\`gh api ${method}\``;
    if (OPAQUE.test(endpoint)) return { what, unreadable: [`names its endpoint as ${endpoint}, which this check cannot read`] };
    const path = endpoint.replace(/^https?:\/\/api\.github\.com/i, "").replace(/^\//, "");
    if (path === "graphql") {
      // A query written out has braces; one the shell fills in, or one read
      // from a file, cannot be read, and neither can a mutation's repository.
      const unread = rest.some((a) => /\bmutation\b/.test(a) || /=@|^--input/.test(a) || /`|\$\(/.test(a) || (OPAQUE.test(a) && !a.includes("{")));
      return unread ? { what: "a GraphQL mutation, or a GraphQL query this check cannot read,", unreadable: ["does not show which repository it writes to"] } : null;
    }
    const m = /^repos\/([^/]+)\/[^/]+/.exec(path);
    if (!m) return null;
    const owners = m[1] === "{owner}" ? [] : [m[1]];
    return { what: `\`gh api ${method} ${path}\``, owners, unreadable: [], named: m[1] !== "{owner}" };
  }
  const skip = new Set();
  const named = flagValues(args, "R", "--repo", skip);
  const words = args.filter((a, i) => !skip.has(i) && !a.startsWith("-"));
  const [group, sub, selector] = words;
  if (!WRITES[group]?.has(sub) || args.some((a) => a === "--help" || a === "-h")) return null;
  const owners = [...urls];
  const unreadable = [];
  for (const repo of named) {
    const t = target(repo);
    if (t.owner) owners.push(t.owner);
    else unreadable.push(t.unreadable);
  }
  // Every write but create names its pull request or issue first.
  if (sub !== "create" && selector !== undefined && OPAQUE.test(selector)) unreadable.push(`names its pull request or issue as ${selector}, which this check cannot read`);
  return { what: `\`gh ${group} ${sub}\``, owners, unreadable, named: named.length > 0 };
}

const gh = (cwd, args) => JSON.parse(execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }));

// The gh writes in a command, every directory it starts in or changes to, and
// every GH_REPO it may run under.
export function writes(command, cwd, env = process.env) {
  const found = [];
  const dirs = new Set([cwd]);
  const ghRepos = new Set(env.GH_REPO ? [env.GH_REPO] : []);
  let dir = cwd;
  for (const base of commands(command)) {
    for (const w of base) if (w.startsWith("GH_REPO=")) ghRepos.add(w.slice(8));
    for (const words of expand(base)) {
      if (words[0] === "cd" || words[0] === "pushd") {
        const to = words[1] ?? env.HOME;
        if (!to || to === "-" || OPAQUE.test(to)) dirs.add(UNKNOWN);
        else {
          const path = to === "~" ? env.HOME : to.startsWith("~/") ? join(env.HOME ?? "", to.slice(2)) : to;
          dir = isAbsolute(path) ? path : join(dir, path);
          dirs.add(dir);
        }
        continue;
      }
      // gh may follow a wrapper the guardrail does not know, such as nice, or
      // come from a variable ($GH pr comment).
      const at = words.findIndex((w, i) => /(^|\/)gh$/.test(w) || (OPAQUE.test(w) && ["pr", "issue", "api"].includes(words[i + 1])));
      if (at < 0) continue;
      const write = ghWrite(words.slice(at + 1));
      if (write) found.push(write);
    }
  }
  return { found, dirs: [...dirs], ghRepos: [...ghRepos] };
}

// The reason to ask before this command, or null to let it run.
export function check(command, cwd, env = process.env) {
  const { found, dirs, ghRepos } = writes(command, cwd, env);
  if (!found.length) return null;
  let gates;
  try {
    gates = loadGates({ root: repoRoot(cwd) });
  } catch (error) {
    return `potluck: the operator's gates could not be read (${error.message}), so ${found[0].what} needs the user's yes until the file is fixed.`;
  }
  if (gates.foreignRepos !== "ask") return null;
  const gate = `potluck operator's gates (foreignRepos: ask, from ${gates.from.foreignRepos})`;
  const ask = (write, why) => `${gate}: ${write.what} ${why}, so it needs the user's yes.`;
  let mine;
  try {
    const login = gh(cwd, ["api", "user"]).login;
    const orgs = gh(cwd, ["api", "--paginate", "--slurp", "user/orgs"]).flat().map((o) => o.login);
    mine = new Set([login, ...orgs].map((name) => name.toLowerCase()));
  } catch (error) {
    return ask(found[0], `writes to a repository, and the gh account could not be read (${String(error.stderr || error.message).trim().split("\n")[0]})`);
  }
  const resolved = new Map();
  const ownerIn = (d) => {
    if (!resolved.has(d)) {
      try {
        resolved.set(d, d === UNKNOWN ? null : gh(d, ["repo", "view", "--json", "owner"]).owner.login);
      } catch {
        resolved.set(d, null);
      }
    }
    return resolved.get(d);
  };
  for (const write of found) {
    if (write.unreadable.length) return ask(write, write.unreadable[0]);
    const owners = [...write.owners];
    if (!write.named) {
      for (const repo of ghRepos) {
        const t = target(repo);
        if (!t.owner) return ask(write, t.unreadable);
        owners.push(t.owner);
      }
      for (const d of dirs) {
        const owner = ownerIn(d);
        if (!owner) return ask(write, `may write to the repository gh resolves in ${d}, which this check cannot read`);
        owners.push(owner);
      }
    }
    const foreign = owners.find((o) => !mine.has(o.toLowerCase()));
    if (foreign) return ask(write, `may write to a repository owned by ${foreign}, which neither the gh account nor its organizations own`);
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
