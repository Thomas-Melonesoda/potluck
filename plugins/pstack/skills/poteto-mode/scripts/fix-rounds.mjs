#!/usr/bin/env node
// potluck: the ceiling of two fix rounds per PR (design row S3-A6), as a check.
//
//   node fix-rounds.mjs start --notes <store>/notes.md --repo <owner/repo> --pr <number> --head <sha>
//
// Run before each fix round, with the head the blocking finding is on. It
// appends one line to the program's notes.md, and that line is the record:
//
//   - fix round 1: owner/repo#12 at <head sha>
//
// A third round on the same PR is refused, for the root to take over. Another
// run at the last recorded head is the same round, so a replaced owner can
// rerun it. There is no override: the root's choices need no third round.
//
// Output is one JSON line: { kind: "started" | "already-started" | "refused" |
// "unavailable", ... }. "unavailable" means notes.md is missing or holds a fix
// round line this script cannot read, so the count is unknown. Exit 0 on
// started or already-started, 1 on refused or unavailable, 2 on a usage error.

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const CEILING = 2;
const RECORD = /^- fix round (\d+): (\S+#\d+) at ([0-9a-f]{40})$/;

function out(result, status) {
  console.log(JSON.stringify(result));
  process.exit(status);
}

function parse() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { notes: { type: "string" }, repo: { type: "string" }, pr: { type: "string" }, head: { type: "string" } },
    });
    if (positionals.join() !== "start") throw new Error("the operation is start");
    if (!values.notes) throw new Error("--notes must be given");
    if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo ?? "")) throw new Error("--repo must be owner/repo");
    if (!/^[1-9]\d*$/.test(values.pr ?? "")) throw new Error("--pr must be a number");
    if (!/^[0-9a-f]{40}$/.test(values.head ?? "")) throw new Error("--head must be a full commit SHA");
    return values;
  } catch (error) {
    process.stderr.write(`fix-rounds.mjs: ${error.message}\nusage: fix-rounds.mjs start --notes <file> --repo <owner/repo> --pr <number> --head <sha>\n`);
    return process.exit(2);
  }
}

const { notes, repo, pr, head } = parse();
const id = `${repo}#${pr}`;

let text;
try {
  text = readFileSync(notes, "utf8");
} catch (error) {
  out({ kind: "unavailable", reason: `${notes} cannot be read (${error.code}); the root writes it in the program's store on the operator's go` }, 1);
}

const rounds = [];
for (const line of text.split(/\r?\n/)) {
  if (!/^\s*[-*+]\s*fix round\b/i.test(line)) continue;
  const record = RECORD.exec(line);
  if (!record) out({ kind: "unavailable", reason: `notes.md has a fix round line this script cannot read: ${line.trim()}` }, 1);
  if (record[2].toLowerCase() === id.toLowerCase()) rounds.push({ round: Number(record[1]), head: record[3] });
}

const last = rounds.at(-1);
if (last?.head === head) out({ kind: "already-started", pr: id, round: last.round, head }, 0);

const round = Math.max(rounds.length, ...rounds.map((r) => r.round)) + 1;
if (round > CEILING) {
  out({ kind: "refused", pr: id, round, reason: `${CEILING} fix rounds are already recorded for ${id}. Hand the PR to the root with the finding and its evidence; the root chooses a fresh owner that tries a different approach, splitting the PR, or parking it as a draft.` }, 1);
}
appendFileSync(notes, `${text && !text.endsWith("\n") ? "\n" : ""}- fix round ${round}: ${id} at ${head}\n`);
out({ kind: "started", pr: id, round, head }, 0);
