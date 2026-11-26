// potluck: the operator's private privacy rules, shared by the repository's
// tools/privacy-check.mjs and the shell hook in operator-gates.mjs. The rules
// live in a terms file outside any repository ($POTLUCK_PRIVATE_TERMS, else
// ${XDG_CONFIG_HOME:-~/.config}/potluck/private-terms.txt):
//   - every other line is a term, matched case-insensitively;
//   - a `vault: <dir>` line adds the distinctive file names in that directory
//     (a non-ASCII name of 4+ characters, or an ASCII name of 16+), and the
//     titles of its Markdown notes.
// Without the file there are no private rules, and every check passes.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// Generic English note names ("template", "preferences") are not private; a vault name only
// counts when it has a non-ASCII character or is long enough to be distinctive.
const distinctive = (name) => (/[^\x00-\x7f]/.test(name) ? [...name].length >= 4 : name.length >= 16);

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

// The private rules a piece of text matches, never the terms themselves.
export function privateMatches(text, rules) {
  const lower = text.toLowerCase();
  const found = [];
  if (rules.terms.some((t) => lower.includes(t))) found.push("private-term");
  if (rules.vaultTitles.some((t) => lower.includes(t))) found.push("vault-file");
  return found;
}
