// potluck: finds a direct merge in a command line, for the git guardrail. A
// pull request is merged only by the merge gate, which runs gh itself, outside
// the hook (stage 5 follow-up issue 1, design row S3-A8).
//
// It reads each simple command the guardrail's lexer finds, past assignments
// and wrappers, up to gh, a shell, or a command whose words are only data. A
// script handed to a shell, eval, or a runner such as trap or parallel is read
// the same way. A script it cannot see (a shell reading stdin, a substitution
// handed to one) falls back to the text of the whole line.
//
// It reads `gh pr merge`, gh aliases for it, and `gh api` on a merge endpoint
// or with a GraphQL merge mutation. Out of its reach: a script file, gh called
// from another language, a name or request built when the command runs or read
// from a file, an alias set earlier, and curl. It stops an agent's shortcut,
// not a deliberate evasion.

import { commands } from "./git-guardrail.mjs";

// Commands whose later words are data, never a command to run.
const DATA = new Set(["echo", "printf", "cat", "ls", "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "jq", "test", "[", "[[", "cd", "rm", "cp", "mv", "mkdir", "touch", "head", "tail", "wc", "sort", "diff", "for", "case", "select", "export", "read", "which", "type", "man", "open", "code"]);
// Commands that run a script given as one word.
const RUNNERS = new Set(["su", "parallel", "trap", "watch", "ssh", "script", "env", "flock", "entr"]);
const SHELL = /^(?:ba|z|da|k|mk|fi|c|tc)?sh$/;
const ASSIGN = /^[A-Za-z_]\w*=/;
const COMPUTED = /^(?:\$\w+|\$\{[^{}]*\}|\$\([\s\S]*\)|`[\s\S]*`)$/;
// gh's flags that take a value, among `gh api`, `gh pr merge`, and --repo.
const VALUED = /^--(method|raw-field|field|input|header|jq|template|preview|cache|hostname|repo|subject|body|body-file|author-email|match-head-commit)(?:=([\s\S]*))?$|^-[a-z]*?([XfFHqtpRbA])=?([\s\S]*)$/;
// A merge endpoint; § stands for a part filled in when the command runs.
const ENDPOINT = /^(?:https?:\/\/[^/]+|§)?\/?(?:api\/v3\/)?(?:repos\/(?:[^/]+\/[^/]+|§)|repositories\/[^/]+|§)\/(?:pulls\/[^/]+\/merge|merges)\/?(?:\?.*)?$/i;
const MUTATION = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\s*\(/;

const base = (word) => word.replace(/^.*\//, "");
const computed = (word) => /[$`]/.test(word);

// What in `line` merges a pull request directly, or null.
export function directMerge(line, depth = 0) {
  if (depth > 4) return null;
  const text = line.replace(/\\\n/g, "");
  for (const words of commands(text)) {
    const found = inCommand(words, text, depth);
    if (found) return found;
  }
  return null;
}

function inCommand(words, line, depth) {
  const script = (text) => directMerge(text, depth + 1) ?? (computed(text) ? inText(line) : null);
  const scripts = (list) => list.reduce((found, text) => found ?? script(text), null);
  let runner = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (ASSIGN.test(word)) continue;
    const name = base(word);
    const rest = words.slice(i + 1);
    if (name === "gh") return inGh(rest, line, depth);
    if (COMPUTED.test(word) && /^(?:pr|api)$/.test(rest[0] ?? "")) return inGh(rest, line, depth);
    if (SHELL.test(name)) return inShell(rest, line, script);
    if (name === "eval") return script(rest.join(" "));
    if (name === "alias") return scripts(rest.map((a) => a.slice(a.indexOf("=") + 1)));
    if (name === "git") return scripts(rest.filter((a) => /^alias\.[^=]*=!/.test(a)).map((a) => a.slice(a.indexOf("!") + 1)));
    if (DATA.has(name)) return null;
    if (RUNNERS.has(name)) runner = true;
    else if (runner && /\s/.test(word)) {
      const found = script(word);
      if (found) return found;
    }
  }
  return null;
}

// A shell's -c script, or the line's text when it reads its script from stdin.
function inShell(args, line, script) {
  const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  if (c >= 0) return script(args.slice(c + 1).find((a) => !a.startsWith("-")) ?? "");
  const operand = args.find((a, i) => !a.startsWith("-") && !/^-[a-z]*[oO]$|^--(?:rcfile|init-file)$/.test(args[i - 1] ?? ""));
  return operand === undefined || operand === "/dev/stdin" || args.includes("-s") ? inText(line) : null;
}

function inText(line) {
  const text = line.replace(/["'\\]/g, "");
  if (/(?<![\w-])gh\s[^\n;|&]*?(?<![\w-])pr\s[^\n;|&]*?(?<![\w-])merge(?![\w-])/.test(text)) return "`gh pr merge` in a script";
  if (/(?<![\w-])gh\s[\s\S]*?(?:pulls\/[^\n]*?\/merge|repos\/[^\n]*?\/merges)(?![\w-])/.test(text)) return "a merge endpoint in a script";
  return MUTATION.test(text) ? "a GraphQL merge mutation in a script" : null;
}

// Each substitution, variable, and gh placeholder as one character.
function parts(word) {
  let text = word;
  for (let before; before !== text; ) [before, text] = [text, text.replace(/\$\([^()]*\)|`[^`]*`|\$\{[^{}]*\}|\$\w+|\([^()]*\)/g, (m) => (m[0] === "(" ? "" : "§"))];
  return text;
}

function inGh(words, line, depth) {
  const [args, queries] = [[], []];
  let [method, fields, input] = [null, false, false];
  for (let i = 0; i < words.length; i++) {
    const flag = VALUED.exec(words[i]);
    if (!flag) {
      if (/^(?:--help|-h|--disable-auto)$/.test(words[i])) return null;
      if (!words[i].startsWith("-")) args.push(words[i]);
      continue;
    }
    const [name, value] = [flag[1] ?? flag[3], (flag[2] ?? flag[4]) || words[++i] || ""];
    if (name === "X" || name === "method") method = value;
    else if (name === "input") fields = input = true;
    else if (/^(?:f|F|field|raw-field)$/.test(name)) {
      fields = true;
      if (value.startsWith("query=")) queries.push(value.slice(6));
    }
  }
  if (args[0] === "alias" && args[1] === "set") return directMerge(`gh ${args.slice(3).join(" ")}`, depth + 1) ?? directMerge(args.slice(3).join(" ").replace(/^!/, ""), depth + 1);
  if (args[0] === "pr" && (args[1] === "merge" || COMPUTED.test(args[1] ?? ""))) return "`gh pr merge`";
  if (args[0] !== "api") return null;
  const endpoint = parts(args[1] ?? "");
  if (/(?:^|\/)graphql\/?(?:\?.*)?$/.test(endpoint)) {
    const unseen = input || queries.some((q) => COMPUTED.test(q) || q.startsWith("@"));
    return queries.some((q) => MUTATION.test(q)) || (unseen && MUTATION.test(line)) ? "a GraphQL merge mutation" : null;
  }
  const reads = /^(?:GET|HEAD)$/i.test(method ?? (fields ? "POST" : "GET"));
  return !reads && ENDPOINT.test(endpoint) ? "`gh api` on a merge endpoint" : null;
}
