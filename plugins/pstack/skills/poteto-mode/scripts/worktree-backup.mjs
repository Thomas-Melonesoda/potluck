#!/usr/bin/env node
// potluck: back up a worktree so deleting it can be undone (design row C3).
//
//   node worktree-backup.mjs <worktree-path> [--trash <dir>] [--keep-days <n>] [--date <YYYY-MM-DD>]
//
// Before `git worktree remove`, this saves everything removal would lose:
//   - tracked uncommitted changes, as one wip commit on a new branch
//     `backup/<name>-<date>` (made with a private index, so the worktree, its
//     index, and its branch are untouched, and no hook runs)
//   - untracked and ignored files outside the audit's DISPOSABLE build and cache
//     directories (such as .env), as a tar.gz under <trash>/<date>/, never in git
//   - commits that only the worktree's HEAD or HEAD reflog reaches, as branches
//     `backup/<name>-<date>-head` and `backup/<name>-<date>-reflog-<sha>`
// It refuses (exit 3, "hold") a worktree that is locked or has a submodule with
// changes, since those need a person or another agent, and it writes nothing
// for them. Trash entries older than --keep-days (default 30, or
// $POTLUCK_TRASH_DAYS) are deleted on each run. Backup branches stay local:
// never push them.
//
// Prints one JSON line. Exit 0 backed-up (or nothing to back up), 3 hold, 2 usage.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DISPOSABLE } from "./worktree-audit.mjs";

const git = (cwd, args, env) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
const lines = (text) => text.split("\n").filter(Boolean);
const z = (text) => text.split("\0").filter(Boolean);

function lockedReason(worktree) {
  const real = git(worktree, ["rev-parse", "--path-format=absolute", "--show-toplevel"]).trim();
  let current = null;
  for (const line of git(worktree, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice(9);
    else if (current === real && line.startsWith("locked")) return line.slice(7).trim() || "locked";
  }
  return null;
}

function dirtySubmodules(worktree) {
  return lines(git(worktree, ["submodule", "status", "--recursive"]))
    .filter((line) => /^[+\-U]/.test(line) || dirtyInside(worktree, line.trim().split(/\s+/)[1]))
    .map((line) => line.trim().split(/\s+/)[1]);
}
function dirtyInside(worktree, path) {
  try {
    return git(join(worktree, path), ["status", "--porcelain"]).trim() !== "";
  } catch {
    return false;
  }
}

const unreached = (worktree, sha) => git(worktree, ["for-each-ref", "--contains", sha, "--format=%(refname)"]).trim() === "";

// A branch name not yet taken, so a second backup the same day never overwrites the first.
function freeBranch(worktree, base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    } catch {
      return name;
    }
  }
}

function pruneTrash(trash, keepDays, now) {
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(trash);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(entry) ? Date.parse(`${entry}T00:00:00Z`) : NaN;
    if (Number.isNaN(day)) continue;
    if (now - day > keepDays * 86_400_000) {
      rmSync(join(trash, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  return removed;
}

export function backup(worktree, { trash, keepDays = 30, date, now = Date.now() }) {
  worktree = resolve(worktree);
  const name = basename(worktree);
  const locked = lockedReason(worktree);
  if (locked) return { kind: "hold", worktree, reason: `locked: ${locked}` };
  const submodules = dirtySubmodules(worktree);
  if (submodules.length) return { kind: "hold", worktree, reason: `submodules with changes: ${submodules.join(", ")}` };

  const result = { kind: "backed-up", worktree, branches: [], tarball: null, prunedTrash: pruneTrash(trash, keepDays, now) };
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();

  // Tracked changes, staged or not, as a commit on top of HEAD.
  if (git(worktree, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]).trim()) {
    const index = join(tmpdir(), `potluck-backup-index-${process.pid}-${now}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      // Start from the worktree's own index, so staged new files are kept too.
      copyFileSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim(), index);
      git(worktree, ["add", "--update", "--", "."], env);
      const tree = git(worktree, ["write-tree"], env).trim();
      const commit = git(worktree, ["commit-tree", tree, "-p", head, "-m", `wip: backup of ${name} before worktree removal`]).trim();
      const branch = freeBranch(worktree, `backup/${name}-${date}`);
      git(worktree, ["branch", branch, commit]);
      result.branches.push({ branch, commit, holds: "uncommitted changes" });
    } finally {
      rmSync(index, { force: true });
    }
  }

  // Commits nothing but HEAD or its reflog reaches.
  if (unreached(worktree, head)) {
    const branch = freeBranch(worktree, `backup/${name}-${date}-head`);
    git(worktree, ["branch", branch, head]);
    result.branches.push({ branch, commit: head, holds: "commits only HEAD reached" });
  }
  let reflog = [];
  try {
    reflog = [...new Set(lines(git(worktree, ["reflog", "--format=%H", "HEAD"])))];
  } catch {}
  const lost = reflog.filter((sha) => unreached(worktree, sha));
  const tips = lost.filter((sha) => !lost.some((other) => other !== sha && isAncestor(worktree, sha, other)));
  for (const sha of tips) {
    const branch = freeBranch(worktree, `backup/${name}-${date}-reflog-${sha.slice(0, 7)}`);
    git(worktree, ["branch", branch, sha]);
    result.branches.push({ branch, commit: sha, holds: "commits only the HEAD reflog reached" });
  }

  // Untracked and ignored files outside build and cache directories.
  const others = z(git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const ignored = z(git(worktree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]));
  const keep = [...new Set([...others, ...ignored])].filter((path) => !path.split("/").some((part) => DISPOSABLE.has(part)));
  if (keep.length) {
    const dir = join(trash, date);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tarball = join(dir, `${name}-${now}.tar.gz`);
    const list = join(dir, `${name}-${now}.files`);
    writeFileSync(list, keep.join("\0"), { mode: 0o600 });
    try {
      execFileSync("tar", ["-czf", tarball, "--null", "-T", list], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    } finally {
      rmSync(list, { force: true });
    }
    result.tarball = { path: tarball, files: keep.length };
  }
  if (!result.branches.length && !result.tarball) result.kind = "nothing-to-back-up";
  return result;
}

function isAncestor(worktree, a, b) {
  try {
    git(worktree, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { trash: { type: "string" }, "keep-days": { type: "string" }, date: { type: "string" } },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const { positionals, values } = parsed;
  const usage = "usage: worktree-backup.mjs <worktree-path> [--trash <dir>] [--keep-days <n>] [--date <YYYY-MM-DD>]\n";
  if (positionals.length !== 1) return process.stderr.write(usage), 2;
  const keepDays = Number(values["keep-days"] ?? process.env.POTLUCK_TRASH_DAYS ?? 30);
  if (!Number.isInteger(keepDays) || keepDays < 1) return process.stderr.write(`--keep-days must be a whole number of days\n${usage}`), 2;
  // The local calendar date, so a backup made late in the evening is filed under that day.
  const today = new Date();
  const local = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  const date = values.date ?? local;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return process.stderr.write(`--date must be YYYY-MM-DD\n${usage}`), 2;
  const trash = resolve(values.trash ?? join(homedir(), ".potluck", "trash"));
  try {
    statSync(positionals[0]);
  } catch {
    return process.stderr.write(`no such worktree: ${positionals[0]}\n`), 2;
  }
  const result = backup(positionals[0], { trash, keepDays, date });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.kind === "hold" ? 3 : 0;
}

if (process.argv[1]?.endsWith("worktree-backup.mjs")) process.exitCode = main(process.argv.slice(2));
