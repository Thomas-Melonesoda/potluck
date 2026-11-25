#!/usr/bin/env node
// potluck: a narrow git guardrail (design row S4-M11), run before each shell
// command the agent sends. With work at risk it blocks only the git commands
// that would lose it, and its message names the safe way to go on, so the
// agent can continue on its own:
//   - `reset --hard`, `clean -f`, `checkout` or `switch` that discards changes,
//     `restore` of the working tree, and a force push without a lease, when the
//     repository has uncommitted changes (untracked files included) or commits
//     on HEAD that no remote branch, other branch, or tag holds
//   - deleting a branch (`branch -D`, `branch -d --force`) that has commits no
//     other branch, tag, or remote holds
// Three push rules hold even in a clean repository, because others build on
// shared branches (stage 5 issue 5) and changes reach a default branch only
// through a pull request (stage 5 follow-up issue 1):
//   - any push to the default branch (the remote's HEAD, main, or master),
//     plain, forced, or with a lease
//   - a push in a line that also switches branches, since this check runs
//     before the line does
//   - deleting a remote branch (`:branch`, `--delete`, `--prune`, `--mirror`)
// A repository the user's own gates file lists in allowDirectPushRepos takes a
// plain push to its default branch; every other rule holds there too.
// A plain push, or one with --force-with-lease (without --force beside it), to
// any other branch, and every other command pass. During a merge, rebase,
// cherry-pick, or revert, taking one side of a conflict (`--ours`,
// `--theirs`) passes, and a blocked call is told to finish or abort the
// operation rather than commit, which would record conflict markers. Commands
// inside `sh -c`, `eval`, subshells, braces, and if or loop bodies are read
// too; heredoc bodies are not commands.
// It reads the hook's JSON on stdin ({ tool_input: { command }, cwd }). Exit 2
// with the reason on stderr blocks the call; exit 0 lets it run. Anything it
// cannot read (no JSON, not a repository, git missing) lets the call run, since
// a guardrail that blocks by mistake stops normal work.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadGates } from "../skills/poteto-mode/scripts/gates.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: Infinity });

// Shell-like words per simple command: quotes and backslashes are honored;
// `;`, `&&`, `||`, `|`, `&`, `(`, `)`, and newlines end a command; a redirect
// ends a word; an escaped newline joins lines; heredoc bodies are skipped, so a
// document that mentions a git command is not read as one. A command
// substitution (`$(...)` or backticks, inside double quotes too) stays inside
// its word, and its commands come before the command that holds it, since they
// run first. A guardrail, not a parser.
export function commands(line) {
  return lex(line).out.map((c) => c.words).filter((words) => words.length);
}

// The commands from `start` up to `stop` (the `)` or backtick that closes a
// substitution) or the end, each with the `scope` it runs in: 0 for the
// command line, a new number for each substitution, whose `cd` does not reach
// past it. An entry with no words is an `event`: a subshell or substitution that
// opens or closes, or `;;`. `end` is the index of the closing character.
function lex(line, start = 0, stop = null, ids = { next: 0, parent: new Map() }, scope = 0) {
  const out = [];
  let words = [];
  let word = null;
  let depth = 0;
  let target = false;
  const heredocs = [];
  const end = () => {
    // A redirect's target is not a word of the command.
    if (word !== null && !target) words.push(word);
    if (word !== null) target = false;
    word = null;
  };
  // The subshells and cases still open: a case pattern's `)` closes neither.
  const nest = [];
  const event = (name) => out.push({ words: [], scope, event: name });
  const split = () => {
    end();
    target = false;
    if (words.length) out.push({ words, scope });
    const head = words[leads(words)];
    if (head === "case") nest.push(head);
    else if (head === "esac" && nest.at(-1) === "case") nest.pop();
    words = [];
  };
  // Reads the substitution that opens at `at`, adds its commands, and returns
  // its raw text and the index that closes it.
  const substitute = (at) => {
    const tick = line[at] === "`";
    const child = ++ids.next;
    ids.parent.set(child, scope);
    const sub = lex(line, at + (tick ? 1 : 2), tick ? "`" : ")", ids, child);
    event("(");
    out.push(...sub.out);
    event(")");
    return { raw: line.slice(at, sub.end + 1), close: sub.end };
  };
  const opens = (j) => (line[j] === "$" && line[j + 1] === "(") || line[j] === "`";
  let i = start;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === stop && (stop === "`" || depth === 0)) break;
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
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length) text += line[++j];
        else if (opens(j)) {
          const { raw, close } = substitute(j);
          text += raw;
          j = close;
        } else text += line[j];
      }
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (c === "#" && word === null) {
      while (i < line.length && line[i] !== "\n") i++;
      i--;
    } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      if (word !== null && /^\d+$/.test(word)) word = null;
      end();
      // The tag is a word after quote removal, so <<EOF, <<'END-NOTE', <<\EOF,
      // and <<E"O"F each close at their bare text. Only a tag that is plainly a
      // name counts; anything else (<<$'EOF', (( x <<= 2 )), (( 1 << $y ))) is
      // read as ordinary words, which can over-block but never hides a command.
      const tag = /^<<-?[ \t]*((?:\\.|'[^']*'|"[^"]*"|[^\s;&|<>()'"\\])+)/.exec(line.slice(i));
      const name = tag && tag[1].replace(/\\(.)|'([^']*)'|"([^"]*)"/g, (_, escaped, single, double) => escaped ?? single ?? double);
      if (name && !tag[1].includes("$") && /^[A-Za-z_][\w.-]*$/.test(name)) {
        heredocs.push(name);
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
    } else if (opens(i)) {
      const { raw, close } = substitute(i);
      word = (word ?? "") + raw;
      i = close;
    } else if (c === "(" || c === ")") {
      depth += c === "(" ? 1 : -1;
      split();
      if (c === "(") nest.push(c);
      if (c === "(" || (nest.at(-1) === "(" && nest.pop())) event(c);
    } else if (";&|".includes(c) && !(c === "&" && line[i + 1] === ">")) {
      split();
      if (c === ";" && line[i + 1] === ";") event(";;");
    } else if (c === "<" || c === ">" || (c === "&" && line[i + 1] === ">")) {
      // A redirect (`2>&1`, `>>`, `&>`, `<<<`): its fd number and its target
      // are not words; `<(` and `>(` keep the commands they run.
      if (word !== null && /^\d+$/.test(word)) word = null;
      end();
      while (i + 1 < line.length && "<>&|".includes(line[i + 1])) i++;
      target = line[i + 1] !== "(";
    } else if (/\s/.test(c)) {
      end();
    } else {
      word = (word ?? "") + c;
    }
  }
  split();
  for (const open of nest) if (open === "(") event(")");
  return { out, end: i };
}

const PREFIXES = new Set(["command", "sudo", "env", "time", "nohup", "exec", "builtin", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "xargs"]);
const SHELLS = /(^|\/)(?:ba|z|da|k)?sh$/;

// How many words stand before the command itself.
function leads(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PREFIXES.has(words[i]))) i++;
  return i;
}

// The commands a simple command runs: itself, or the script it hands to
// `sh -c` or `eval`.
export function expand(words, depth = 0) {
  let i = leads(words);
  if (words[i] === "timeout") i += 2;
  const head = words[i];
  const inner = (script) => (depth < 4 ? commands(script).flatMap((w) => expand(w, depth + 1)) : []);
  if (head === "eval") return inner(words.slice(i + 1).join(" "));
  if (SHELLS.test(head ?? "")) {
    const flag = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
    if (flag > 0 && words[flag + 1] !== undefined) return inner(words[flag + 1]);
    return [];
  }
  return [words.slice(i)];
}

// The word that closes each compound command.
const CLOSERS = new Map([["if", "fi"], ["case", "esac"], ["while", "done"], ["until", "done"], ["for", "done"], ["select", "done"], ["{", "}"]]);

// Calls `visit` with each command a line runs and the folder it runs in, until
// one returns a reason. A shell is its `dir`, null where that cannot be told,
// and the compound commands open in it. Each branch starts where its compound
// command did, and one whose body changed the folder leaves it unknown, since
// the body may not have run.
function walk(line, visit, shell, depth = 0) {
  const shells = [shell];
  for (const { words, event } of lex(line).out) {
    if (event === ")") shells.pop();
    const now = shells.at(-1);
    if (event === "(") shells.push({ dir: now.dir, blocks: [] });
    let k = leads(words);
    for (const word of event === ";;" ? [event] : words.slice(0, k + 1)) {
      const block = now.blocks.at(-1);
      if (CLOSERS.has(word)) now.blocks.push({ closer: CLOSERS.get(word), entry: now.dir });
      else if (block && (["else", "elif", ";;"].includes(word) || word === block.closer)) {
        block.moved ||= now.dir !== block.entry;
        now.dir = word === block.closer && block.moved ? null : block.entry;
        if (word === block.closer) now.blocks.pop();
      }
    }
    if (words[k] === "timeout") k += 2;
    const [head = "", ...args] = words.slice(k);
    if (head === "cd") now.dir = enter(now.dir, ...args.filter((word) => !/^(?:--|-[LPe]+)$/.test(word)));
    else if (head === "pushd" || head === "popd") now.dir = null;
    const script = head === "eval" ? args.join(" ") : SHELLS.test(head) ? args.find((_, j) => /^-[a-z]*c[a-z]*$/.test(args[j - 1])) : undefined;
    const inner = head === "eval" ? now : { dir: now.dir, blocks: [] };
    const reason = script === undefined ? visit([head, ...args], now.dir) : depth < 4 && walk(script, visit, inner, depth + 1);
    if (reason) return reason;
  }
  return null;
}

// The git subcommand a simple command runs, with the directory it runs in.
export function gitCall(words, cwd, resolve = resolveDir) {
  let i = leads(words);
  if (!/(^|\/)git$/.test(words[i] ?? "")) return null;
  i++;
  let dir = cwd;
  let elsewhere = false;
  while (i < words.length && words[i].startsWith("-")) {
    const option = words[i];
    if (option === "--help") return null;
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(option)) elsewhere = true;
    if (option === "-C") dir = resolve(dir, words[++i] ?? ".");
    else if (option === "--work-tree") dir = resolve(dir, words[++i] ?? ".");
    else if (option.startsWith("--work-tree=")) dir = resolve(dir, option.slice("--work-tree=".length));
    else if (option === "-c" || option === "--git-dir" || option === "--namespace") i++;
    i++;
  }
  if (i >= words.length) return null;
  return { dir, sub: words[i], args: words.slice(i + 1), ...(elsewhere && { elsewhere }) };
}

const resolveDir = (base, path) => {
  const home = path === "~" || path.startsWith("~/") ? join(process.env.HOME ?? "~", path.slice(1)) : path;
  return isAbsolute(home) ? home : join(base, home);
};
// Where a `cd` from `base` leads, or null where that cannot be told: a path the
// shell computes, `-`, a folder that is not there, or a step from an unknown one.
const enter = (base, path = "~", ...more) => {
  if (more.length || /^-|[$`]/.test(path) || (base === null && !/^[/~]/.test(path))) return null;
  const dir = resolveDir(base ?? "/", path);
  return existsSync(`${dir}/`) ? dir : null;
};
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

// git push's long options. git takes any unambiguous prefix (`--force-w`,
// `--del`), and the VALUED ones may take their value as the next word.
const PUSH_OPTIONS = ["all", "branches", "mirror", "tags", "follow-tags", "atomic", "dry-run", "no-dry-run", "porcelain", "delete", "prune", "force", "force-with-lease", "force-if-includes", "repo", "receive-pack", "exec", "push-option", "recurse-submodules", "signed", "set-upstream", "quiet", "verbose", "progress", "thin", "verify", "ipv4", "ipv6", "no-verify", "no-thin", "no-signed", "no-atomic", "no-follow-tags", "no-progress", "no-force-with-lease", "no-force-if-includes", "no-recurse-submodules"];
const VALUED = new Set(["repo", "receive-pack", "exec", "push-option", "recurse-submodules"]);
function longOption(word) {
  const name = word.slice(2).split("=")[0];
  if (PUSH_OPTIONS.includes(name)) return name;
  const hits = PUSH_OPTIONS.filter((option) => option.startsWith(name));
  return hits.length === 1 ? hits[0] : null;
}

// A push's options, its remote, and its refspec words. A dry run asks nothing.
function pushPlan(args) {
  const plan = { force: false, delete: false, every: false, prune: false, tags: false, remote: undefined, refspecs: [] };
  let dry = args.length === 1 && args[0] === "-h";
  let repo;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (a === "--help") return null;
    if (a.startsWith("--")) {
      const name = longOption(a);
      if (name === "repo") repo = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
      if (VALUED.has(name) && !a.includes("=")) i++;
      else if (name === "force" || name === "force-with-lease") plan.force = true;
      else if (name === "delete") plan.delete = true;
      else if (name === "all" || name === "branches") plan.every = true;
      else if (name === "mirror") Object.assign(plan, { every: true, prune: true, force: true });
      else if (name === "prune") plan.prune = true;
      else if (name === "tags") plan.tags = true;
      else if (name === "dry-run" || name === "no-dry-run") dry = name === "dry-run";
    } else if (/^-./.test(a)) {
      // A short cluster; `-o` takes the rest of it, or the next word, as its value.
      for (let k = 1; k < a.length; k++) {
        if (a[k] === "o") {
          if (k === a.length - 1) i++;
          break;
        }
        if (a[k] === "f") plan.force = true;
        else if (a[k] === "d") plan.delete = true;
        else if (a[k] === "n") dry = true;
      }
    } else words.push(a);
  }
  if (dry) return null;
  return { ...plan, remote: words[0] ?? repo, refspecs: words.slice(1) };
}

// One refspec: its source, its destination ("" for HEAD), whether it named a
// destination, and whether it forces or deletes. `:` alone is every branch.
function refspec(word, force, del) {
  const plus = word.startsWith("+");
  const spec = plus ? word.slice(1) : word;
  if (spec === ":") return { every: true, force: force || plus };
  const colon = spec.indexOf(":");
  const dst = spec.slice(colon + 1);
  const src = colon < 0 ? spec : spec.slice(0, colon);
  // An empty source or the null hash deletes the destination.
  return { src, dst: ["HEAD", "@"].includes(dst) ? "" : dst, named: colon >= 0, force: force || plus, delete: del || colon === 0 || /^(0{40}|0{64})$/.test(src) };
}

// A destination as a branch name, or null for a tag or other ref. git reads
// `heads/x` as refs/heads/x and `tags/x` as a tag.
const branchName = (dst) =>
  dst.startsWith("refs/heads/") ? dst.slice(11) : dst.startsWith("heads/") ? dst.slice(6) : dst.startsWith("refs/") || dst.startsWith("tags/") ? null : dst;

// Whether a destination writes branch `name`. git matches a `*` pattern
// against full ref names, so `refs/*` and `r*` cover refs/heads/main.
function covers(dst, name) {
  if (!dst.includes("*")) return branchName(dst) === name;
  const pattern = new RegExp(`^${dst.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return [`refs/heads/${name}`, `heads/${name}`, name].some((ref) => pattern.test(ref));
}

// A destination the command computes when it runs.
const computed = (dst) => /[$`]/.test(dst);

// A github.com repository in a plain https or ssh URL or the scp form. Nothing
// but name characters may stand before the host, so no other host fits there.
const GITHUB = /^(?:(?:https|ssh):\/\/(?:\w[\w.-]*@)?github\.com\/|(?:\w[\w.-]*@)?github\.com:)([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/;

// Whether the user's own gates file lists every repository a push to `remote`
// writes. A remote given as a URL, or a gates file that cannot be read, is no.
function directPushAllowed(read, remote) {
  const urls = read(["remote", "get-url", "--push", "--all", remote]).split("\n").filter(Boolean);
  try {
    const listed = loadGates().allowDirectPushRepos ?? [];
    return urls.length > 0 && urls.every((url) => listed.includes(GITHUB.exec(url)?.[1].toLowerCase()));
  } catch {
    return false;
  }
}

// The push rules that hold in a clean repository: no push that lands on a
// default branch, and no deleted remote branch. A forced push passes only when
// every branch it writes can be read and none is a default branch. `elsewhere`
// is a push with --git-dir or --work-tree, whose repository is not `dir`'s.
// `older` leaves out the rules on a push that is not forced.
function sharedPush({ dir, args, elsewhere }, older) {
  const plan = pushPlan(args);
  if (!plan) return null;
  const read = (args) => {
    try {
      return dir === null ? "" : git(dir, args).trim();
    } catch {
      return "";
    }
  };
  const current = read(["symbolic-ref", "-q", "--short", "HEAD"]);
  // The remote a push with none named goes to, in git's order.
  const remote = plan.remote || (current && read(["config", `branch.${current}.pushRemote`])) || read(["config", "remote.pushDefault"]) || (current && read(["config", `branch.${current}.remote`])) || "origin";
  // A mirror remote makes every push a --mirror push.
  if (read(["config", "--bool", `remote.${remote}.mirror`]) === "true") Object.assign(plan, { every: true, prune: true, force: true });
  if (plan.prune) {
    return "potluck git guardrail: blocked a push with --prune or --mirror, which deletes every remote branch that has no local copy. Deleting remote branches is the user's call: ask the user, or push the branches you mean by name without those options.";
  }
  const known = read(["rev-parse", "--git-dir"]) !== "";
  // remote.<name>.push decides where a push with no destination goes.
  const configured = read(["config", "--get-all", `remote.${remote}.push`]).split("\n").filter(Boolean);
  const specs = plan.refspecs.map((word) => refspec(word, plan.force, plan.delete));
  if (configured.length && (!specs.length || specs.some((s) => !s.named))) specs.push(...configured.map((word) => refspec(word, plan.force, false)));
  if (!specs.length && !plan.every && !plan.tags) specs.push({ implicit: true, force: plan.force });
  const forcesEvery = plan.every && plan.force;

  for (const spec of specs.filter((s) => s.delete)) {
    const branch = spec.dst === "" ? current : computed(spec.dst) ? "named when the command runs" : spec.dst.includes("*") ? spec.dst : branchName(spec.dst);
    if (branch) {
      return `potluck git guardrail: blocked deleting the remote branch ${branch}. Deleting a remote branch is the user's call: ask the user, or let the forge delete it when its pull request merges. To delete a tag, name it in full (\`refs/tags/<name>\`).`;
    }
  }

  const shared = new Set(["main", "master"]);
  const head = read(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]);
  if (head) shared.add(head.slice(`refs/remotes/${remote}/`.length));
  const upstreamOf = (branch) => {
    const ref = read(["config", `branch.${branch}.merge`]);
    return ref && branchName(ref);
  };
  const mode = read(["config", "push.default"]) || "simple";
  const local = () => (known ? read(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n") : [null]);
  // Each branch a forced spec writes; null where the guardrail cannot tell.
  const writes = (spec) => {
    if (spec.every) return local();
    if (spec.implicit || spec.dst === "") {
      if (!known) return [null];
      if (spec.dst === "") return [current];
      if (mode === "matching") return local();
      if (mode === "current") return [current];
      if (mode === "upstream" || mode === "tracking") return [upstreamOf(current)];
      return mode === "nothing" ? [] : [current, upstreamOf(current)];
    }
    if (computed(spec.dst)) return [null];
    return [spec.dst, !spec.named && mode === "upstream" && known && upstreamOf(branchName(spec.src))];
  };
  const forced = [...(forcesEvery ? local() : []), ...specs.filter((s) => s.force).flatMap(writes)];
  const hit = [...shared].find((name) => forced.some((target) => target && covers(target, name)));
  if (hit) {
    return `potluck git guardrail: blocked a force push to ${hit}, a default branch (the remote's default, main, or master). Others build on it, so rewriting it breaks their copies, and a lease does not change that: a lease only checks that you have seen the remote's commits. Push the change to a new branch and open a pull request; if the history must be rewritten, ask the user to do it.`;
  }
  if (forced.includes(null)) {
    return `potluck git guardrail: blocked a force push whose branch it cannot read (${known ? "the branch is computed when the command runs" : "the repository it runs in could not be read"}). A force push that may land on a default branch is blocked, so name the branch plainly (\`git push --force-with-lease origin <branch>\`); it passes when that branch is not a default branch.`;
  }
  if (older) return null;
  const unnamed = (spec) => spec.every || spec.implicit || !spec.dst || computed(spec.dst);
  if ((elsewhere || !known) && (plan.every || specs.some((s) => !s.delete && unnamed(s)))) {
    return "potluck git guardrail: blocked a push that lands by the branch of a repository this check cannot read (its folder is worked out when the command runs, or named with --git-dir or --work-tree). Run these as two commands: cd into the repository first, then push. Or name a branch of your own (`git push -u origin <branch>`).";
  }
  const pushed = [...(plan.every ? local() : []), ...specs.filter((s) => !s.force && !s.delete).flatMap(writes)];
  const landed = [...shared].find((name) => pushed.some((target) => target && covers(target, name)));
  // A branch computed when the command runs is most often the current one, so
  // it is blocked only where the current branch is a default branch.
  const unread = !landed && known && pushed.includes(null) && [...shared].some((name) => covers(current, name));
  if ((!landed && !unread) || (!elsewhere && directPushAllowed(read, remote))) return null;
  if (landed) {
    return `potluck git guardrail: blocked a push to ${landed}, a default branch. Changes reach a default branch only through a pull request: push to a branch of your own (\`git push -u origin <branch>\`) and open a pull request. A person can still merge on GitHub's website.`;
  }
  return `potluck git guardrail: blocked a push whose branch is computed when the command runs while ${current}, a default branch, is checked out, since it may land there. Push from a branch of your own and name it plainly (\`git push -u origin <branch>\`).`;
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
  let switches = false;
  let pushes = false;
  const judged = new Set();
  const judge = (call, older) => {
    const key = JSON.stringify(call);
    if (judged.has(key)) return null;
    judged.add(key);
    return checkOne(call, older);
  };
  const blocked = walk(command, (words, dir) => {
    const call = gitCall(words, dir, enter);
    switches ||= switchesBranch(call, words);
    pushes ||= call?.sub === "push" && pushPlan(call.args) !== null;
    return judge(call);
  }, { dir: cwd, blocks: [] });
  if (blocked) return blocked;
  // The rules on forced pushes, deletions, and lost work also keep the reading
  // they had before `walk`, which follows only a leading `cd`, so nothing they
  // block passes because a `cd` is now followed.
  // The directory each scope is in: a `cd` inside a substitution stays there,
  // and reaches the substitutions nested in it.
  const ids = { next: 0, parent: new Map() };
  const dirs = new Map([[0, cwd]]);
  const dirOf = (scope) => dirs.get(scope) ?? dirOf(ids.parent.get(scope) ?? 0);
  for (const { words: base, scope } of lex(command, 0, null, ids).out) {
    const dir = dirOf(scope);
    if (base[0] === "cd" && base.length <= 2) {
      dirs.set(scope, resolveDir(dir, base[1] ?? process.env.HOME ?? dir));
      continue;
    }
    for (const words of expand(base)) {
      const reason = judge(gitCall(words, dir), true);
      if (reason) return reason;
    }
  }
  if (!switches || !pushes) return null;
  return "potluck git guardrail: blocked a line that switches branches and pushes, since this check runs before the line does and cannot tell which branch the push would land on. Run these as two commands: switch first, then push.";
}

function namesFile(dir, path) {
  if (existsSync(resolveDir(dir, path))) return true;
  try {
    git(dir, ["ls-files", "--error-unmatch", "--", path]);
    return true;
  } catch {
    return false;
  }
}

// A call that may change which branch is checked out: git switch, checkout (not
// of paths after --), a branch rename, stash branch, symbolic-ref, a rebase of a
// named branch, or gh pr checkout and its alias gh co.
function switchesBranch(call, words) {
  if (!call) return /(^|\/)gh$/.test(words[0] ?? "") && (words[1] === "co" || (words.includes("pr") && words.includes("checkout")));
  const { sub, args } = call;
  const named = args.filter((a) => !a.startsWith("-"));
  if (sub === "checkout") return !args.includes("--");
  if (sub === "branch") return /[mM]/.test(shortFlags(args)) || args.includes("--move");
  if (sub === "stash") return named[0] === "branch";
  return sub === "switch" || (["symbolic-ref", "rebase"].includes(sub) && named.length > 1);
}

function checkOne(call, older) {
  if (!call) return null;
  let found = risk(call);
  // The push rules hold even where the repository cannot be read.
  if (call.sub === "push") {
    const shared = sharedPush(call, older);
    if (shared || !found) return shared;
  }
  if (!found || call.dir === null) return null;
  try {
    git(call.dir, ["rev-parse", "--git-dir"]);
  } catch {
    return null;
  }
  const op = inProgress(call.dir);
  if (found.maybePath !== undefined) {
    // A word that names a commit switches branches, and git carries the edits
    // along or refuses. A word that names no file either (a branch only on a
    // remote, which git creates locally, or a typo git rejects) discards nothing.
    let commit = true;
    try {
      git(call.dir, ["rev-parse", "--verify", "--quiet", `${found.maybePath}^{commit}`]);
    } catch {
      commit = false;
    }
    if (commit || !namesFile(call.dir, found.maybePath)) return null;
    found = "checkout that discards changes";
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
  else safe = 'Save the work first, then rerun: for uncommitted changes, commit the files this task touched, each by name (`git add <file>... && git commit -m "wip: before <what you are doing>"`), and keep commits reachable with `git branch backup/<name>`. Changes this task did not make belong to someone else: leave them, and work in a fresh worktree if they are in the way. A clean repository whose commits another ref holds passes.';
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
