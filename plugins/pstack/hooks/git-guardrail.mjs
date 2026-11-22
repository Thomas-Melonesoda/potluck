#!/usr/bin/env node
// potluck: a narrow git guardrail (design row M11), run before each shell
// command the agent sends. A clean repository passes everything. With work at
// risk it blocks only the git commands that would lose it, and its message
// names the safe way to go on, so the agent can continue on its own:
//   - `reset --hard`, `clean -f`, `checkout` or `switch` that discards changes,
//     `restore` of the working tree, and a force push without a lease, when the
//     repository has uncommitted changes (untracked files included) or commits
//     on HEAD that no remote branch, other branch, or tag holds
//   - deleting a branch (`branch -D`, `branch -d --force`) that has commits no
//     other branch, tag, or remote holds
// A plain push, a push with --force-with-lease, and every other command pass.
// It reads the hook's JSON on stdin ({ tool_input: { command }, cwd }). Exit 2
// with the reason on stderr blocks the call; exit 0 lets it run. Anything it
// cannot read (no JSON, not a repository, git missing) lets the call run, since
// a guardrail that blocks by mistake stops normal work.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: Infinity });

// Shell-like words per simple command: quotes and backslashes are honored, and
// `;`, `&&`, `||`, `|`, `&`, and newlines end a command. A guardrail, not a parser.
export function commands(line) {
  const out = [];
  let words = [];
  let word = null;
  const end = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const split = () => {
    end();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      word = (word ?? "") + line.slice(i + 1, close < 0 ? line.length : close);
      i = close < 0 ? line.length : close;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      for (; j < line.length && line[j] !== '"'; j++) text += line[j] === "\\" && j + 1 < line.length ? line[++j] : line[j];
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (c === "#" && word === null) {
      while (i < line.length && line[i] !== "\n") i++;
      split();
    } else if (";&|\n".includes(c)) {
      split();
    } else if (/\s/.test(c)) {
      end();
    } else {
      word = (word ?? "") + c;
    }
  }
  split();
  return out;
}

const PREFIXES = new Set(["command", "sudo", "env", "time", "nohup", "exec", "builtin"]);

// The git subcommand a simple command runs, with the directory it runs in.
export function gitCall(words, cwd) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PREFIXES.has(words[i]))) i++;
  if (!/(^|\/)git$/.test(words[i] ?? "")) return null;
  i++;
  let dir = cwd;
  while (i < words.length && words[i].startsWith("-")) {
    const option = words[i];
    if (option === "-C") dir = resolveDir(dir, words[++i] ?? ".");
    else if (option === "-c" || option === "--git-dir" || option === "--work-tree" || option === "--namespace") i++;
    i++;
  }
  if (i >= words.length) return null;
  return { dir, sub: words[i], args: words.slice(i + 1) };
}

const resolveDir = (base, path) => (isAbsolute(path) ? path : join(base, path));
const shortFlags = (args) => args.filter((a) => /^-[^-]/.test(a)).join("");

// What a git call would lose: "changes" (uncommitted work and commits only
// HEAD holds), a branch name, or nothing.
export function risk({ sub, args }) {
  const has = (...names) => args.some((a) => names.includes(a));
  const paths = args.includes("--") || args.some((a) => a === "." || a === ":/" || a.startsWith(":(top)"));
  switch (sub) {
    case "reset":
      return has("--hard") ? "reset --hard" : null;
    case "clean":
      return (shortFlags(args).includes("f") || has("--force")) && !shortFlags(args).includes("n") && !has("--dry-run") ? "clean -f" : null;
    case "checkout":
      return paths || shortFlags(args).includes("f") || has("--force") ? "checkout that discards changes" : null;
    case "switch":
      return shortFlags(args).includes("f") || has("--force", "--discard-changes") ? "switch that discards changes" : null;
    case "restore": {
      const staged = has("--staged") || shortFlags(args).includes("S");
      const worktree = has("--worktree") || shortFlags(args).includes("W");
      return !staged || worktree ? "restore of the working tree" : null;
    }
    case "push": {
      const lease = args.some((a) => a.startsWith("--force-with-lease"));
      const force = has("--force") || shortFlags(args).includes("f") || args.some((a) => /^\+[^+]/.test(a));
      return force && !lease ? "force push without a lease" : null;
    }
    case "branch": {
      const flags = shortFlags(args);
      const forced = flags.includes("D") || ((flags.includes("d") || has("--delete")) && (flags.includes("f") || has("--force")));
      if (!forced) return null;
      return { branches: args.filter((a) => !a.startsWith("-")) };
    }
    default:
      return null;
  }
}

// Commits `ref` reaches that no remote, tag, or branch other than `except` holds.
function onlyHere(dir, ref, except) {
  const others = git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"])
    .split("\n")
    .filter((r) => r && r !== except);
  const count = execFileSync("git", ["-C", dir, "rev-list", "--count", "--stdin", ref], {
    input: others.map((r) => `^${r}`).join("\n"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: Infinity,
  });
  return Number(count.trim());
}

export function check(command, cwd) {
  let dir = cwd;
  for (const words of commands(command)) {
    if (words[0] === "cd" && words.length <= 2) {
      dir = resolveDir(dir, words[1] ?? process.env.HOME ?? dir);
      continue;
    }
    const call = gitCall(words, dir);
    if (!call) continue;
    const found = risk(call);
    if (!found) continue;
    try {
      git(call.dir, ["rev-parse", "--git-dir"]);
    } catch {
      continue;
    }
    if (typeof found === "object") {
      for (const branch of found.branches) {
        let lost;
        try {
          lost = onlyHere(call.dir, `refs/heads/${branch}`, `refs/heads/${branch}`);
        } catch {
          continue;
        }
        if (lost) {
          return `potluck git guardrail: \`git branch\` would delete ${branch}, which has ${lost} commit(s) no other branch, tag, or remote holds. Keep them first, then delete: push it (\`git push -u origin ${branch}\`), merge it, or keep a copy with \`git branch backup/${branch} ${branch}\`.`;
        }
      }
      continue;
    }
    const dirty = git(call.dir, ["status", "--porcelain", "--untracked-files=all"]).trim() !== "";
    let head = 0;
    try {
      const branch = git(call.dir, ["symbolic-ref", "-q", "HEAD"]).trim();
      head = onlyHere(call.dir, "HEAD", branch);
    } catch {
      head = (() => {
        try {
          return onlyHere(call.dir, "HEAD", null);
        } catch {
          return 0;
        }
      })();
    }
    if (!dirty && !head) continue;
    const at = [dirty && "uncommitted changes", head && `${head} commit(s) on HEAD that no remote, other branch, or tag holds`].filter(Boolean).join(" and ");
    const safe =
      found === "force push without a lease"
        ? "Push with `--force-with-lease` instead, which refuses when the remote has commits you have not seen."
        : 'Save the work first, then rerun: `git add -A && git commit -m "wip: before <what you are doing>"` for uncommitted changes, and `git branch backup/<name>` so the commits stay reachable. A clean repository whose commits another ref holds passes.';
    return `potluck git guardrail: blocked a ${found} while the repository has ${at}. ${safe}`;
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
  let reason = null;
  try {
    reason = check(command, input.cwd || process.cwd());
  } catch {
    return 0;
  }
  if (!reason) return 0;
  process.stderr.write(`${reason}\n`);
  return 2;
}

if (process.argv[1]?.endsWith("git-guardrail.mjs")) process.exitCode = main(readFileSync(0, "utf8"));
