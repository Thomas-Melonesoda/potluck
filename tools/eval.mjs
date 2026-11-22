#!/usr/bin/env node
// potluck: eval layers 1 and 2 (design row D8). Free and deterministic, so CI runs both.
//
//   node tools/eval.mjs            both layers
//   node tools/eval.mjs --layer 1  structure
//   node tools/eval.mjs --layer 2  triggers and collisions
//   node tools/eval.mjs --report   also print each trigger case's rank
//
// Layer 1, structure: every skill has a name that matches its folder and a
// description within the length runtimes accept; poteto-mode's playbook list
// and its playbook files match one to one; every user-invocable skill has at
// least one trigger case, and every case names a skill that exists.
//
// Layer 2, triggers: a lexical stand-in for routing. Each skill's description
// (plus its name) becomes a TF-IDF vector over stemmed words, and each case's
// prompt is ranked against all of them. A positive case passes when its skill
// ranks in the top `topK`; a negative case passes when none of its `not`
// skills ranks first with a score of at least `minScore` (a prompt that matches
// no skill fires none); a positive whose skill's description shares no word
// with the prompt has not fired at all, so the name alone never passes a case; the share of positives ranked first must stay at or
// above `minRank1`. A case marked `known` with a reason is a recorded miss: it is
// reported, not failed, and it fails once it passes, so the list stays true. An
// allowed collision that no longer collides fails the same way. Two descriptions closer than `collision` fail unless the pair is
// listed in `allowCollisions` with a reason. A lexical score cannot judge
// meaning (layer 3, a real agent run, does), but it catches a description that
// lacks the words users say and two descriptions that read alike. A failure
// here usually means fix the description, not the case.
//
// Cases live in evals/triggers.json. Exit 0 when every check passes, 1 when one
// fails, 2 on a usage error.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

// The frontmatter fields this check reads: a one-line scalar (plain, single-,
// or double-quoted) or a `>` or `|` block, whose indented lines are joined.
export function frontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text.replaceAll("\r\n", "\n"))?.[1] ?? "";
  const field = (key) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block);
    const raw = match?.[1]?.trim();
    if (raw === undefined) return undefined;
    if (/^[>|][+-]?$/.test(raw)) {
      const rest = block.slice(match.index + match[0].length + 1).split("\n");
      const lines = [];
      for (const line of rest) {
        if (line.trim() && !/^\s/.test(line)) break;
        lines.push(line.trim());
      }
      return lines.join(raw[0] === ">" ? " " : "\n").trim();
    }
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw.slice(1, -1);
      }
    }
    if (raw.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    return raw;
  };
  return { name: field("name"), description: field("description"), userInvocable: field("user-invocable") !== "false" };
}

export function loadSkills(root = ROOT) {
  const dir = join(root, "plugins/pstack/skills");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => ({ dir: entry.name, ...frontmatter(readFileSync(join(dir, entry.name, "SKILL.md"), "utf8")) }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

const STOP = new Set(
  "a an and are as at be but by can do does dont doesnt for from has have i if im in into is it its ive me my no not of on or our so that the their then there these this to up use used uses using was we when where which while who will with without you your youre".split(" "),
);

// A light suffix stemmer, enough to put "change", "changes", "changed", and
// "changing" on one stem: strip one inflection, then a final "e".
export function stem(word) {
  let w = word;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ied") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (/(?:ss|sh|ch|x|z)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w) && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

export const tokens = (text) =>
  text.toLowerCase().replace(/['\u2019]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

// TF-IDF vectors for the skills, and a scorer for a prompt against them.
// A skill's name counts once beside its description, since a user who names
// the skill means it. `described(i, prompt)` says whether the prompt shares a
// word with the description itself, so a case cannot pass on the name alone.
export function index(skills) {
  const own = skills.map((s) => new Set(tokens(s.description ?? "")));
  const docs = skills.map((s) => [...tokens(s.description ?? ""), ...tokens(s.dir.replaceAll("-", " "))]);
  const df = new Map();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t) => Math.log((docs.length + 1) / ((df.get(t) ?? 0) + 1)) + 1;
  const vector = (words) => {
    const v = new Map();
    for (const t of words) v.set(t, (v.get(t) ?? 0) + 1);
    let norm = 0;
    for (const [t, n] of v) {
      const w = n * idf(t);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  };
  const cosine = (a, b) => {
    let sum = 0;
    for (const [t, w] of a) sum += w * (b.get(t) ?? 0);
    return sum;
  };
  const vectors = docs.map(vector);
  return {
    described: (skill, prompt) => tokens(prompt).some((w) => own[skills.findIndex((s) => s.dir === skill)]?.has(w)),
    rank: (prompt) => {
      const q = vector(tokens(prompt));
      return skills.map((s, i) => ({ skill: s.dir, score: cosine(q, vectors[i]) })).sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
    },
    pairs: () => {
      const out = [];
      for (let i = 0; i < skills.length; i++) {
        for (let j = i + 1; j < skills.length; j++) out.push({ a: skills[i].dir, b: skills[j].dir, score: cosine(vectors[i], vectors[j]) });
      }
      return out;
    },
  };
}

export function layer1(skills, cases, playbooks) {
  const problems = [];
  const names = new Set(skills.map((s) => s.dir));
  for (const s of skills) {
    if (s.name !== s.dir) problems.push(`skills/${s.dir}: frontmatter name is ${JSON.stringify(s.name)}, not the folder name`);
    if (s.dir.length > MAX_NAME || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.dir)) problems.push(`skills/${s.dir}: name must be lowercase words joined by hyphens, at most ${MAX_NAME} characters`);
    if (!s.description) problems.push(`skills/${s.dir}: no description`);
    else if (s.description.length > MAX_DESCRIPTION) problems.push(`skills/${s.dir}: description is ${s.description.length} characters, over ${MAX_DESCRIPTION}`);
  }
  const covered = new Set(cases.filter((c) => c.skill).map((c) => c.skill));
  for (const s of skills) if (s.userInvocable && !covered.has(s.dir)) problems.push(`skills/${s.dir}: no trigger case in evals/triggers.json`);
  for (const c of cases) {
    for (const name of [c.skill, ...(c.not ?? [])].filter(Boolean)) {
      if (!names.has(name)) problems.push(`evals/triggers.json: case ${JSON.stringify(c.prompt)} names ${name}, which is not a skill`);
    }
    if (c.known !== undefined && (typeof c.known !== "string" || !c.known.trim())) problems.push(`evals/triggers.json: case ${JSON.stringify(c.prompt)} has a "known" mark without a reason`);
    if (!c.skill && !c.not?.length) problems.push(`evals/triggers.json: case ${JSON.stringify(c.prompt)} has neither "skill" nor "not"`);
  }
  if (playbooks) {
    const kebab = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const listed = new Set(playbooks.titles.map(kebab));
    for (const file of playbooks.files) if (!listed.has(file)) problems.push(`poteto-mode/playbooks/${file}.md: not in poteto-mode's playbook list`);
    for (const slug of listed) if (!playbooks.files.includes(slug)) problems.push(`poteto-mode's playbook list names ${slug}, which has no playbooks/${slug}.md`);
  }
  return problems;
}

export function layer2(skills, config) {
  const { cases, topK = 3, minRank1 = 0, minScore = 0, collision = 1, allowCollisions = [] } = config;
  const idx = index(skills);
  const problems = [];
  const report = [];
  let positives = 0;
  let first = 0;
  for (const c of cases) {
    const ranked = idx.rank(c.prompt);
    if (c.skill) {
      positives++;
      // A skill whose description shares no word with the prompt has not fired,
      // whatever its place: the name alone does not count.
      const at = ranked.findIndex((r) => r.skill === c.skill);
      const rank = at < 0 || ranked[at].score === 0 || !idx.described(c.skill, c.prompt) ? Infinity : at + 1;
      if (rank === 1) first++;
      report.push({ prompt: c.prompt, skill: c.skill, rank, top: ranked[0].skill, known: c.known });
      const missed = rank > topK;
      if (missed && !c.known) problems.push(`trigger: "${c.prompt}" ranks ${c.skill} at ${rank}, outside the top ${topK} (first: ${ranked[0].skill})`);
      if (!missed && c.known) problems.push(`trigger: "${c.prompt}" now ranks ${c.skill} at ${rank}; remove its "known" mark`);
    }
    if (c.not) {
      const fired = c.not.filter((name) => ranked[0].skill === name && ranked[0].score >= minScore);
      if (fired.length && !c.known) problems.push(`trigger: "${c.prompt}" ranks ${fired[0]} first (score ${ranked[0].score.toFixed(2)}), which it must not`);
      if (!fired.length && c.known) problems.push(`trigger: "${c.prompt}" no longer fires ${c.not.join(" or ")}; remove its "known" mark`);
    }
  }
  const rate = positives ? Math.round((first / positives) * 1000) / 10 : 100;
  if (rate < minRank1) problems.push(`trigger: ${rate}% of positive cases rank their skill first, under the floor of ${minRank1}%`);
  const names = new Set(skills.map((s) => s.dir));
  for (const { pair, why } of allowCollisions.map((entry) => entry ?? {})) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((name) => names.has(name)) || typeof why !== "string" || !why.trim()) {
      problems.push(`evals/triggers.json: allowCollisions entry ${JSON.stringify(pair)} needs two existing skills and a reason`);
    }
  }
  const key = (pair) => [...pair].sort().join(" ");
  const allowed = new Set(allowCollisions.filter(({ pair }) => Array.isArray(pair)).map(({ pair }) => key(pair)));
  const scores = new Map(idx.pairs().map(({ a, b, score }) => [key([a, b]), { a, b, score }]));
  for (const { a, b, score } of scores.values()) {
    if (score >= collision && !allowed.has(key([a, b]))) {
      problems.push(`collision: ${a} and ${b} descriptions are ${score.toFixed(2)} alike, at or over ${collision}; make them distinct or list the pair in allowCollisions with a reason`);
    }
  }
  for (const pair of allowed) {
    const found = scores.get(pair);
    if (found && found.score < collision) problems.push(`collision: ${found.a} and ${found.b} are ${found.score.toFixed(2)} alike now, under ${collision}; remove the pair from allowCollisions`);
  }
  return { problems, report, rate };
}

export function readPlaybooks(root = ROOT) {
  const mode = join(root, "plugins/pstack/skills/poteto-mode");
  const text = readFileSync(join(mode, "SKILL.md"), "utf8");
  const section = text.split(/^## Playbooks$/m)[1] ?? "";
  // The list is the first paragraph of comma-separated titles in the section.
  const line = section.split("\n").find((l) => /^[A-Z][A-Za-z -]+(, [A-Z][A-Za-z -]+){5,}\.?$/.test(l.trim())) ?? "";
  return {
    titles: line.trim().replace(/\.$/, "").split(", "),
    files: readdirSync(join(mode, "playbooks")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort(),
  };
}

export function main(argv, root = ROOT) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { layer: { type: "string" }, report: { type: "boolean" } } }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (values.layer && !["1", "2"].includes(values.layer)) return process.stderr.write("--layer must be 1 or 2\n"), 2;
  const skills = loadSkills(root);
  const config = JSON.parse(readFileSync(join(root, "evals/triggers.json"), "utf8"));
  const problems = [];
  if (values.layer !== "2") problems.push(...layer1(skills, config.cases, readPlaybooks(root)));
  if (values.layer !== "1") {
    const { problems: found, report, rate } = layer2(skills, config);
    problems.push(...found);
    if (values.report) for (const r of report) process.stdout.write(`${r.rank === 1 ? " " : r.known ? "k" : "*"} ${String(r.rank === Infinity ? "-" : r.rank).padStart(2)} ${r.skill.padEnd(36)} ${r.prompt}${r.rank === 1 ? "" : `  (first: ${r.top})`}\n`);
    process.stdout.write(`layer 2: ${report.length} positive cases, ${rate}% rank their skill first\n`);
  }
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`ok: eval layer${values.layer ? ` ${values.layer}` : "s 1 and 2"} pass (${skills.length} skills, ${config.cases.length} cases)\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
