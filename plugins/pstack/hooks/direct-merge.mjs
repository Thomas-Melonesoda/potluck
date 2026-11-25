// potluck: finds a direct merge in a command line, for the git guardrail. A
// pull request is merged only by the merge gate, which runs gh itself, outside
// the hook (stage 5 follow-up issue 1, design row S3-A8).
//
// It reads each simple command the guardrail's lexer finds, past assignments
// and wrappers, up to gh, a shell, or a command whose words are only data. A
// script handed to a shell, eval, or a runner such as trap or ssh is read the
// same way, where the runner is the command itself. An argument with a space
// in it is text, and a script or word it cannot read passes.
//
// It reads `gh pr merge`, gh aliases for it, and `gh api` on a merge endpoint
// or with a GraphQL merge mutation. Out of its reach: a script from a file or
// stdin, gh called from another language, anything built when the command runs
// or read from a file, an alias set earlier, a script given as one word to a
// wrapper it does not know (tmux, env -S), and curl. It stops an agent's
// shortcut, not a deliberate evasion.

import { commands } from "./git-guardrail.mjs";

// Commands whose later words are data, never a command to run.
const DATA = new Set(["echo", "printf", "cat", "ls", "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "jq", "test", "[", "[[", "cd", "rm", "cp", "mv", "mkdir", "touch", "head", "tail", "wc", "sort", "diff", "for", "case", "select", "export", "read", "which", "type", "man", "open", "code"]);
// Wrappers and runners: the short options that take a value, and how many
// words come before the command. A runner's command is a line of its own.
const WRAPPERS = { env: ["uC", 0], timeout: ["ks", 1], gtimeout: ["ks", 1], nice: ["n", 0], sudo: ["ugpCDhRTU", 0], xargs: ["IJnPLEds", 0], exec: ["a", 0], stdbuf: ["ioe", 0], caffeinate: ["tw", 0], ...Object.fromEntries(["nohup", "command", "builtin", "noglob", "time", "then", "do", "else", "elif", "if", "while", "until", "!", "{"].map((name) => [name, ["", 0]])) };
const RUNNERS = { su: ["", 0], parallel: ["jSNnLPIa", 0], trap: ["", 0], watch: ["n", 0], ssh: ["bcDEeFIiJLlmOopQRSWw", 1], script: ["cEIoOTBm", 1], flock: ["wE", 1], entr: ["", 0] };
const SHELL = /^(?:ba|z|da|k|mk|fi|c|tc)?sh$/;
const ASSIGN = /^[A-Za-z_]\w*=/;
const COMPUTED = /^(?:\$\w+|\$\{[^{}]*\}|\$\([\s\S]*\)|`[\s\S]*`)$/;
// gh's flags that take a value, among `gh api`, `gh pr merge`, and --repo.
const VALUED = /^--(method|raw-field|field|input|header|jq|template|preview|cache|hostname|repo|subject|body|body-file|author-email|match-head-commit)(?:=([\s\S]*))?$|^-[a-z]*?([XfFHqtpRbA])=?([\s\S]*)$/;
// A merge endpoint; § stands for a part filled in when the command runs.
const ENDPOINT = /^(?:https?:\/\/[^/]+|§)?\/?(?:api\/v3\/)?(?:repos\/(?:[^/]+\/[^/]+|§)|repositories\/[^/]+|§)\/(?:pulls\/[^/]+\/merge|merges)\/?(?:\?.*)?$/i;
const MUTATION = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\s*\(/;

const base = (word) => word.replace(/^.*\//, "");

// Where the command after a wrapper's or runner's options and `count` words starts.
function after(words, i, [valued, count]) {
  for (; i < words.length; i++) {
    if (/^-./.test(words[i])) i += words[i].length === 2 && valued.includes(words[i][1]) ? 1 : 0;
    else if (!ASSIGN.test(words[i]) && count-- <= 0) break;
  }
  return i;
}

// What in `line` merges a pull request directly, or null.
export function directMerge(line, depth = 0) {
  if (depth > 4) return null;
  const text = line.replace(/\\\n/g, "");
  for (const words of commands(text)) {
    const found = inCommand(words, depth);
    if (found) return found;
  }
  return null;
}

function inCommand(words, depth) {
  const script = (text) => directMerge(text, depth + 1);
  const scripts = (list) => list.reduce((found, text) => found ?? script(text), null);
  let head = after(words, 0, ["", 0]);
  while (Object.hasOwn(WRAPPERS, base(words[head] ?? ""))) head = after(words, head + 1, WRAPPERS[base(words[head])]);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (ASSIGN.test(word)) continue;
    const name = base(word);
    const rest = () => words.slice(i + 1);
    if (name === "gh") return inGh(rest(), depth);
    if (COMPUTED.test(word) && /^(?:pr|api)$/.test(words[i + 1] ?? "")) return inGh(rest(), depth);
    if (SHELL.test(name)) return inShell(rest(), script);
    if (name === "eval") return script(rest().join(" "));
    if (name === "alias") return scripts(rest().map((a) => a.slice(a.indexOf("=") + 1)));
    if (name === "git") return scripts(rest().filter((a) => /^alias\.[^=]*=!/.test(a)).map((a) => a.slice(a.indexOf("!") + 1)));
    if (DATA.has(name)) return null;
    if (i === head && Object.hasOwn(RUNNERS, name)) {
      const start = after(words, i + 1, RUNNERS[name]);
      const command = words.slice(start).map((w, k) => (k && /\s/.test(w) ? `'${w.replaceAll("'", "'\\''")}'` : w));
      // su takes its script with -c anywhere, script only among its options.
      const found = inShell(name === "su" ? rest() : name === "script" ? words.slice(i, start) : [], script) ?? script(command.join(" "));
      if (found) return found;
    }
  }
  return null;
}

// A shell's -c script.
function inShell(args, script) {
  const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  return c < 0 ? null : script(args.slice(c + 1).find((a) => !a.startsWith("-")) ?? "");
}

// Each substitution, variable, and gh placeholder as one character.
function parts(word) {
  let [text, depth] = ["", 0];
  for (const c of word) {
    if (c === "(" && depth++ === 0) text = text.endsWith("$") ? `${text.slice(0, -1)}§` : text;
    else if (c === ")" && depth) depth--;
    else if (!depth) text += c;
  }
  return text.replace(/`[^`]*`|\$\{[^{}]*\}|\$\w+/g, "§");
}

function inGh(words, depth) {
  const [args, queries] = [[], []];
  let [method, fields] = [null, false];
  for (let i = 0; i < words.length; i++) {
    const flag = VALUED.exec(words[i]);
    if (!flag) {
      if (/^(?:--help|-h|--disable-auto)$/.test(words[i])) return null;
      if (!words[i].startsWith("-")) args.push(words[i]);
      continue;
    }
    const [name, value] = [flag[1] ?? flag[3], (flag[2] ?? flag[4]) || words[++i] || ""];
    if (name === "X" || name === "method") method = value;
    else if (name === "input") fields = true;
    else if (/^(?:f|F|field|raw-field)$/.test(name)) {
      fields = true;
      if (value.startsWith("query=")) queries.push(value.slice(6));
    }
  }
  if (args[0] === "alias" && args[1] === "set") return directMerge(`gh ${args.slice(3).join(" ")}`, depth + 1) ?? directMerge(args.slice(3).join(" ").replace(/^!/, ""), depth + 1);
  if (args[0] === "pr" && args[1] === "merge") return "`gh pr merge`";
  if (args[0] !== "api") return null;
  const endpoint = parts(args[1] ?? "");
  if (/(?:^|\/)graphql\/?(?:\?.*)?$/.test(endpoint)) return queries.some((q) => MUTATION.test(q)) ? "a GraphQL merge mutation" : null;
  const reads = /^(?:GET|HEAD)$/i.test(method ?? (fields ? "POST" : "GET"));
  return !reads && ENDPOINT.test(endpoint) ? "`gh api` on a merge endpoint" : null;
}
