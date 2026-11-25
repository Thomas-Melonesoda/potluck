// potluck: the two-fix-round ceiling (S3-A6) in
// plugins/pstack/skills/poteto-mode/scripts/fix-rounds.mjs.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/fix-rounds.mjs");
const [A, B, C] = ["a", "b", "c"].map((c) => c.repeat(40));
const root = mkdtempSync(join(tmpdir(), "potluck-fix-rounds-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function store(text = "# Objective\n\nLand the queue.\n") {
  const notes = join(root, `notes-${++n}.md`);
  if (text !== null) writeFileSync(notes, text);
  const start = (head, { pr = "7", repo = "o/r" } = {}) => {
    const r = spawnSync("node", [script, "start", "--notes", notes, "--repo", repo, "--pr", pr, "--head", head], { encoding: "utf8" });
    return { status: r.status, ...JSON.parse(r.stdout || "{}") };
  };
  return { notes, start, read: () => readFileSync(notes, "utf8") };
}

test("two rounds start and are recorded in notes.md, and a third stops with the hand-over to the root", () => {
  const s = store();
  expect(s.start(A)).toMatchObject({ status: 0, kind: "started", round: 1 });
  expect(s.start(B)).toMatchObject({ status: 0, kind: "started", round: 2 });
  const before = s.read();
  expect(before).toBe(`# Objective\n\nLand the queue.\n- fix round 1: o/r#7 at ${A}\n- fix round 2: o/r#7 at ${B}\n`);
  const third = s.start(C);
  expect(third).toMatchObject({ status: 1, kind: "refused", round: 3 });
  expect(third.reason).toContain("Hand the PR to the root");
  expect(third.reason).toContain("a fresh owner that tries a different approach, splitting the PR, or parking it as a draft");
  expect(s.read()).toBe(before);
});

test("each PR of each repository has its own count", () => {
  const s = store();
  for (const head of [A, B]) s.start(head);
  expect(s.start(C, { pr: "8" })).toMatchObject({ status: 0, round: 1 });
  expect(s.start(C, { pr: "77" })).toMatchObject({ status: 0, round: 1 });
  expect(s.start(C, { repo: "o/r2" })).toMatchObject({ status: 0, round: 1 });
  expect(s.start(C, { repo: "O/R" }).status).toBe(1);
});

test("a rerun at the same head is the same round, so a replaced owner does not use one up", () => {
  const s = store();
  s.start(A);
  expect(s.start(A)).toMatchObject({ status: 0, kind: "already-started", round: 1 });
  s.start(B);
  expect(s.start(B)).toMatchObject({ status: 0, kind: "already-started", round: 2 });
  expect(s.read().match(/fix round/g)).toHaveLength(2);
  // An earlier round's head is not the round in progress.
  expect(s.start(A)).toMatchObject({ status: 1, kind: "refused" });
});

test("a removed record does not lower the count", () => {
  const s = store(`- fix round 2: o/r#7 at ${B}\n`);
  expect(s.start(C)).toMatchObject({ status: 1, kind: "refused" });
});

test("a notes.md without a final newline, or with CRLF lines, keeps its text and its records", () => {
  const s = store(`objective\r\n- fix round 1: o/r#7 at ${A}\r\nlast words`);
  expect(s.start(B)).toMatchObject({ status: 0, round: 2 });
  expect(s.read()).toContain(`last words\n- fix round 2: o/r#7 at ${B}\n`);
  expect(s.start(C).status).toBe(1);
});

test.each(["- fix round 2: the parser one", "* Fix round 1: o/r#7 at abc", "  - fix round two"])("a record it cannot read stops the round: %s", (line) => {
  const s = store(`${line}\n`);
  expect(s.start(A)).toMatchObject({ status: 1, kind: "unavailable" });
  expect(s.read()).toBe(`${line}\n`);
});

test("a missing notes.md stops the round and is not created", () => {
  const s = store(null);
  expect(s.start(A)).toMatchObject({ status: 1, kind: "unavailable" });
  expect(existsSync(s.notes)).toBe(false);
});

test.each([
  ["a short head", ["start", "--notes", "x", "--repo", "o/r", "--pr", "7", "--head", "abc"]],
  ["a PR that is not a number", ["start", "--notes", "x", "--repo", "o/r", "--pr", "#7", "--head", A]],
  ["a repository without an owner", ["start", "--notes", "x", "--repo", "r", "--pr", "7", "--head", A]],
  ["no notes", ["start", "--repo", "o/r", "--pr", "7", "--head", A]],
  ["no operation", ["--notes", "x", "--repo", "o/r", "--pr", "7", "--head", A]],
  ["a way around the ceiling", ["start", "--notes", "x", "--repo", "o/r", "--pr", "7", "--head", A, "--force"]],
])("%s is a usage error", (_, args) => {
  expect(spawnSync("node", [script, ...args]).status).toBe(2);
});
