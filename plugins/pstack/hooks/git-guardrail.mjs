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
// A plain push, a push with --force-with-lease (without --force beside it), and
// every other command pass. During a merge, rebase, cherry-pick, or revert,
// taking one side of a conflict (`--ours`, `--theirs`) passes, and a blocked
// call is told to finish or abort the operation rather than commit, which would
// record conflict markers. Commands inside `sh -c`, `eval`, subshells, braces,
// and if or loop bodies are read too; heredoc bodies are not commands.
// It reads the hook's JSON on stdin ({ tool_input: { command }, cwd }). Exit 2
// with the reason on stderr blocks the call; exit 0 lets it run. Anything it
// cannot read (no JSON, not a repository, git missing) lets the call run, since
// a guardrail that blocks by mistake stops normal work.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: Infinity });

// Shell-like words per simple command: quotes and backslashes are honored;
// `;`, `&&`, `||`, `|`, `&`, `(`, `)`, and newlines end a command; a redirect
// ends a word; an escaped newline joins lines; heredoc bodies are skipped, so a
// document that mentions a git command is not read as one. A guardrail, not a
// parser.
export function commands(line) {
  const out = [];
  let words = [];
  let word = null;
  const heredocs = [];
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
    if (c === "\\" && line[i + 1] === "\n") {
      i++;
      end();
    } else if (c === "'") {
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
      i--;
    } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      end();
      const tag = /^<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
      if (tag) {
        heredocs.push(tag[2]);
        i += tag[0].length - 1;
      } else i++;
    } else if (c === "\n") {
      split();
      // Skip each pending heredoc body up to its closing tag.
      while (heredocs.length) {
        const tag = heredocs.shift();
        let next = line.indexOf("\n", i + 1);
        while (true) {
          const body = line.slice(i + 1, next < 0 ? line.length : next);
          i = next < 0 ? line.length : next;
          if (body.replace(/^\t+/, "") === tag || next < 0) break;
          next = line.indexOf("\n", i + 1);
        }
      }
    } else if (";&|()".includes(c)) {
      split();
    } else if (c === "<" || c === ">") {
      end();
    } else if (/\s/.test(c)) {
      end();
    } else {
      word = (word ?? "") + c;
    }
  }
  split();
  return out;
}

const PREFIXES = new Set(["command", "sudo", "env", "time", "nohup", "exec", "builtin", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "xargs"]);
const SHELLS = /(^|\/)(?:ba|z|da|k)?sh$/;

// The commands a simple command runs: itself, or the script it hands to
// `sh -c` or `eval`.
function expand(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PREFIXES.has(words[i]))) i++;
  if (words[i] === "timeout") i += 2;
  const head = words[i];
  if (head === "eval") return commands(words.slice(i + 1).join(" "));
  if (SHELLS.test(head ?? "")) {
    const flag = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
    if (flag > 0 && words[flag + 1] !== undefined) return commands(words[flag + 1]);
    return [];
  }
  return [words.slice(i)];
}

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
    else if (option === "--work-tree") dir = resolveDir(dir, words[++i] ?? ".");
    else if (option.startsWith("--work-tree=")) dir = resolveDir(dir, option.slice("--work-tree=".length));
    else if (option === "-c" || option === "--git-dir" || option === "--namespace") i++;
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
    case "checkout": {
      if (has("--ours", "--theirs", "-m", "--merge") || args.some((a) => a.startsWith("--conflict"))) return { side: "checkout that discards changes" };
      if (paths || shortFlags(args).includes("f") || has("--force")) return "checkout that discards changes";
      if (shortFlags(args).match(/[bB]/) || has("--orphan", "--detach")) return null;
      // `checkout <commit> <path>` restores the path; one bare word is a path
      // only when it names no commit, which check() asks git.
      const words = args.filter((a) => !a.startsWith("-"));
      if (words.length >= 2) return "checkout that discards changes";
      return words.length === 1 && words[0] !== "-" ? { maybePath: words[0] } : null;
    }
    case "switch":
      return shortFlags(args).includes("f") || has("--force", "--discard-changes") ? "switch that discards changes" : null;
    case "restore": {
      if (has("--ours", "--theirs", "-m", "--merge") || args.some((a) => a.startsWith("--conflict"))) return { side: "restore of the working tree" };
      const staged = has("--staged") || shortFlags(args).includes("S");
      const worktree = has("--worktree") || shortFlags(args).includes("W");
      return !staged || worktree ? "restore of the working tree" : null;
    }
    case "push": {
      // A plain --force overrides a lease given beside it.
      const plain = has("--force") || shortFlags(args).includes("f");
      const lease = args.some((a) => a.startsWith("--force-with-lease")) && !plain;
      const force = plain || args.some((a) => /^\+[^+]/.test(a));
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

const OPERATIONS = [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]];

// The merge, rebase, cherry-pick, or revert in progress, if any.
function inProgress(dir) {
  for (const [name, op] of OPERATIONS) {
    if (existsSync(git(dir, ["rev-parse", "--path-format=absolute", "--git-path", name]).trim())) return op;
  }
  return null;
}

export function check(command, cwd) {
  let dir = cwd;
  for (const base of commands(command)) {
    if (base[0] === "cd" && base.length <= 2) {
      dir = resolveDir(dir, base[1] ?? process.env.HOME ?? dir);
      continue;
    }
    for (const words of expand(base)) {
      const reason = checkOne(words, dir);
      if (reason) return reason;
    }
  }
  return null;
}

function checkOne(words, dir) {
  const call = gitCall(words, dir);
  if (!call) return null;
  let found = risk(call);
  if (!found) return null;
  try {
    git(call.dir, ["rev-parse", "--git-dir"]);
  } catch {
    return null;
  }
  const op = inProgress(call.dir);
  if (found.maybePath !== undefined) {
    try {
      git(call.dir, ["rev-parse", "--verify", "--quiet", `${found.maybePath}^{commit}`]);
      return null;
    } catch {
      found = "checkout that discards changes";
    }
  }
  if (found.side) {
    // Taking one side of a conflict is how a merge or rebase gets resolved.
    if (op) return null;
    found = found.side;
  }
  if (found.branches) {
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
    return null;
  }
  const dirty = git(call.dir, ["status", "--porcelain", "--untracked-files=all"]).trim() !== "";
  let head = 0;
  try {
    const branch = git(call.dir, ["symbolic-ref", "-q", "HEAD"]).trim();
    head = onlyHere(call.dir, "HEAD", branch);
  } catch {
    try {
      head = onlyHere(call.dir, "HEAD", null);
    } catch {
      head = 0;
    }
  }
  if (!dirty && !head) return null;
  const at = [dirty && "uncommitted changes", head && `${head} commit(s) on HEAD that no remote, other branch, or tag holds`].filter(Boolean).join(" and ");
  let safe;
  if (found === "force push without a lease") safe = "Push with `--force-with-lease` instead, which refuses when the remote has commits you have not seen.";
  else if (op) safe = `A ${op} is in progress, so do not commit to save the work: that would record conflict markers. Finish it (resolve each file, \`git add\` it, then \`git ${op} --continue\`) or abort it (\`git ${op} --abort\`). To take one side of a conflicted file, use \`git checkout --ours <file>\` or \`--theirs\`, which passes.`;
  else safe = 'Save the work first, then rerun: `git add -A && git commit -m "wip: before <what you are doing>"` for uncommitted changes, and `git branch backup/<name>` so the commits stay reachable. A clean repository whose commits another ref holds passes.';
  return `potluck git guardrail: blocked a ${found} while the repository has ${at}. ${safe}`;
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
