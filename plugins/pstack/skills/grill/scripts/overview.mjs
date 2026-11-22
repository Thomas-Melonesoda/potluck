#!/usr/bin/env node
// potluck: the project overview (design rows R2 and R4), generated from the
// sources grill writes, so a person can read in one page what the project is,
// how far along it is, and what is left.
//
//   node overview.mjs [--root <dir>]            print the overview
//   node overview.mjs [--root <dir>] --write    write docs/overview.md
//   node overview.mjs [--root <dir>] --check    exit 1 if docs/overview.md is stale
//
// Sources (row R1): docs/features/*.md, GLOSSARY.md, CONSTRAINTS.md,
// docs/adr/*.md, docs/rulings.md, and the README's title and first paragraph
// for what the project is. A project without feature files needs no overview. A feature's "Done when" items are
// checkboxes; an item counts as met only when it is ticked and names its proof
// on the same line ("Proof: <test, command, or verification note>"). A tick
// without proof is an error, so progress is never just an agent's word.
//
// The overview is read-only: its header names the hash of the sources it was
// built from, and --check (which the merge gate runs) fails when the sources
// changed and the overview was not regenerated, or when a tick has no proof.
// Exit 0 ok (or no feature files and no overview), 1 stale or invalid, 2 usage.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const OUT = "docs/overview.md";
const SELF = fileURLToPath(import.meta.url);
const FEATURE_FILE = /\.(md|markdown)$/i;

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n") : null);
const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && FEATURE_FILE.test(e.name)).map((e) => e.name).sort() : []);
// Anything in docs/features/ that is not a feature file the overview reads.
const strays = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => !(e.isFile() && FEATURE_FILE.test(e.name))).map((e) => e.name).sort() : []);
// Markdown-safe table cells and link targets.
const cell = (text) => text.replaceAll("|", "\\|");
const target = (path) => (/[\s()<>]/.test(path) ? `<${path}>` : path);

export function sources(root) {
  const files = [
    ...mdFiles(join(root, "docs/features")).map((f) => `docs/features/${f}`),
    "README.md",
    "GLOSSARY.md",
    "CONSTRAINTS.md",
    ...mdFiles(join(root, "docs/adr")).map((f) => `docs/adr/${f}`),
    "docs/rulings.md",
  ];
  return files.map((rel) => ({ rel, text: read(join(root, rel)) })).filter((s) => s.text !== null);
}

const sourceHash = (list) => {
  const h = createHash("sha256");
  for (const { rel, text } of list) h.update(`${rel}\0${text}\0`);
  return h.digest("hex").slice(0, 16);
};

// One feature file: its title, first paragraph, "For:" line, and Done when items.
export function feature(rel, text) {
  const lines = text.split("\n");
  const titleAt = lines.findIndex((l) => l.startsWith("# "));
  const title = titleAt >= 0 ? lines[titleAt].slice(2).trim() : basename(rel).replace(FEATURE_FILE, "");
  // Summary and audience come only from the part before the first section.
  const firstSection = lines.findIndex((l, i) => i > titleAt && l.startsWith("## "));
  const intro = lines.slice(titleAt + 1, firstSection < 0 ? lines.length : firstSection).join("\n");
  const summary = intro.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(\*\*)?For:/i.test(p)) ?? "";
  const forWhom = /^(?:\*\*)?For:(?:\*\*)?\s*(.+)$/im.exec(intro)?.[1]?.trim() ?? "";
  const start = lines.findIndex((l) => /^##\s+Done when:?\s*$/i.test(l));
  const items = [];
  const problems = [];
  if (start < 0) problems.push(`${rel}: no "## Done when" section`);
  else {
    for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
      const m = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$/.exec(lines[i]);
      if (!m) {
        if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(lines[i])) problems.push(`${rel}:${i + 1}: a Done when item must be a checkbox ("- [ ] ...")`);
        continue;
      }
      const done = m[1] !== " ";
      const proof = /\bProof:\s*(\S.*)$/i.exec(m[2]);
      const what = (proof ? m[2].slice(0, proof.index) : m[2]).trim().replace(/[\s.;,]+$/, "");
      if (done && !proof) problems.push(`${rel}:${i + 1}: ticked without proof; add "Proof: <test, command, or verification note>" or untick it`);
      items.push({ what, done: done && Boolean(proof), proof: proof?.[1].trim() ?? null });
    }
    if (!items.length) problems.push(`${rel}: "## Done when" has no items`);
  }
  return { rel, title, summary, forWhom, items, problems };
}

const tableRows = (text, heading) => {
  const section = text.split(/^## /m).find((s) => s.toLowerCase().startsWith(heading));
  if (!section) return [];
  return section.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*:?-/.test(l)).slice(1);
};
// A table row's cells, split on unescaped pipes, empty cells kept.
const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());

export function build(root) {
  const list = sources(root);
  const features = list.filter((s) => s.rel.startsWith("docs/features/")).map((s) => feature(s.rel, s.text));
  // The overview belongs to a project that keeps feature files. Other sources
  // alone (a CONSTRAINTS.md, an ADR) do not call for one.
  if (!features.length) return { text: null, problems: [] };
  const problems = [
    ...features.flatMap((f) => f.problems),
    ...strays(join(root, "docs/features")).map((n) => `docs/features/${n}: put each feature in its own .md file directly in docs/features/`),
  ];
  const met = features.reduce((n, f) => n + f.items.filter((i) => i.done).length, 0);
  const total = features.reduce((n, f) => n + f.items.length, 0);
  const out = [];
  out.push(`<!-- Generated by potluck's grill/scripts/overview.mjs from the project's sources; do not edit. Regenerate with --write. sources: ${sourceHash(list)} -->`);
  const readme = list.find((s) => s.rel === "README.md");
  const name = readme?.text.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim();
  const about = readme?.text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("[") && !p.startsWith("<") && !p.startsWith(">") && !p.startsWith("!"));
  out.push("", `# ${name ? `${name}: overview` : "Project overview"}`, "");
  if (about) out.push(about, "");
  out.push(`${features.length} feature${features.length === 1 ? "" : "s"}; ${met} of ${total} done conditions met with proof.`, "");
  if (features.length) {
    out.push("| Feature | For | Met | Open |", "| --- | --- | --- | --- |");
    for (const f of features) {
      const done = f.items.filter((i) => i.done).length;
      out.push(`| [${cell(f.title)}](${target(`features/${basename(f.rel)}`)}) | ${cell(f.forWhom) || "-"} | ${done} of ${f.items.length} | ${f.items.length - done} |`);
    }
    out.push("");
    for (const f of features) {
      out.push(`## ${f.title}`, "");
      if (f.summary) out.push(f.summary, "");
      for (const i of f.items) out.push(i.done ? `- [x] ${i.what} (proof: ${i.proof})` : `- [ ] ${i.what}`);
      out.push("");
    }
  }
  const constraints = list.find((s) => s.rel === "CONSTRAINTS.md");
  if (constraints) {
    const rows = tableRows(constraints.text, "enforced");
    out.push("## Quality bar", "", `[CONSTRAINTS.md](../CONSTRAINTS.md): the floor, plus ${rows.length} enforced rule${rows.length === 1 ? "" : "s"}.`, "");
    for (const row of rows) {
      const c = cells(row);
      if (c.length >= 3) out.push(`- ${c[0]}: ${c[1]} (checked by ${c[2]})`);
    }
    if (rows.length) out.push("");
  }
  const adrs = list.filter((s) => s.rel.startsWith("docs/adr/"));
  if (adrs.length) {
    out.push("## Decisions", "");
    for (const a of adrs) out.push(`- [${a.text.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? basename(a.rel)}](${target(`adr/${basename(a.rel)}`)})`);
    out.push("");
  }
  const rulings = list.find((s) => s.rel === "docs/rulings.md");
  if (rulings) out.push("## Rulings", "", "The user's own decisions, in their words: [docs/rulings.md](rulings.md).", "");
  const glossary = list.find((s) => s.rel === "GLOSSARY.md");
  if (glossary) {
    const terms = [...glossary.text.matchAll(/^\*\*([^*]+)\*\*:/gm)].map((m) => m[1].trim());
    out.push("## Terms", "", terms.length ? terms.join(", ") : "See [GLOSSARY.md](../GLOSSARY.md).", "");
  }
  return { text: `${out.join("\n").replace(/\n+$/, "")}\n`, problems };
}

export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { root: { type: "string" }, write: { type: "boolean" }, check: { type: "boolean" } } }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (values.write && values.check) return process.stderr.write("use --write or --check, not both\n"), 2;
  const root = values.root ?? process.cwd();
  const { text, problems } = build(root);
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  const path = join(root, OUT);
  if (values.check) {
    if (text === null) {
      if (!existsSync(path)) return 0;
      process.stderr.write(`${OUT} exists but docs/features/ has no feature files; delete ${OUT} or restore the features\n`);
      return 1;
    }
    if (read(path) !== text) {
      process.stderr.write(`${OUT} is stale or missing; run node ${SELF} --write and commit it\n`);
      return 1;
    }
    process.stdout.write(`ok: ${OUT} is current\n`);
    return 0;
  }
  if (text === null) return process.stdout.write("no feature files in docs/features/ yet, so no overview\n"), 0;
  if (values.write) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(path, text);
    process.stdout.write(`write: ${OUT}\n`);
    return 0;
  }
  process.stdout.write(text);
  return 0;
}

if (process.argv[1]?.endsWith("overview.mjs")) process.exitCode = main(process.argv.slice(2));
