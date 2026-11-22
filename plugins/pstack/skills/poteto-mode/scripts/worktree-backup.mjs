#!/usr/bin/env node
// potluck: back up a worktree so deleting it can be undone (design row C3).
//
//   node worktree-backup.mjs <worktree-path> [--trash <dir>] [--keep-days <n>] [--date <YYYY-MM-DD>]
//
// Before `git worktree remove`, this saves everything removal would lose:
//   - tracked uncommitted changes, as wip commits on a new branch
//     `backup/<name>-<date>`: one for the index as staged, one on top for the
//     files on disk (made with a private index, so the worktree, its index,
//     and its branch are untouched, and no hook runs)
//   - every untracked file, and ignored files outside the audit's DISPOSABLE
//     build and cache directories (such as .env), as a tar.gz under
//     <trash>/<date>/, never in git
//   - commits that only the worktree's HEAD or HEAD reflog reaches, as branches
//     `backup/<name>-<date>-head` and `backup/<name>-<date>-reflog-<sha>`
// It refuses (exit 3, "hold") a worktree that is locked, has any initialized
// submodule (or files in an uninitialized submodule's folder), has unmerged
// paths, or has no commit yet, and it writes nothing for them. Trash entries older than --keep-days (default 30, or
// $POTLUCK_TRASH_DAYS) are deleted on each run. Backup branches stay local:
// never push them.
//
// Prints one JSON line. Exit 0 backed-up (or nothing to back up), 3 hold, 2 usage.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// Submodules removal could lose work in. A submodule keeps its own objects,
// reflog, stashes, and ignored files under this worktree's git dir, and three
// rounds of probing kept finding new ways for work to hide there, so any
// initialized submodule holds the worktree for a person or a later pass. An
// uninitialized one holds it too when its folder has files, since git does
// not see files written there. Submodules are read as gitlinks from the index
// (`ls-files -s -z`, mode 160000), so a path with spaces stays whole and a
// gitlink with no .gitmodules entry still counts; an initialized submodule's
// folder always has files (its .git at least), so one test covers both.
function riskySubmodules(worktree) {
  const paths = z(git(worktree, ["ls-files", "-s", "-z"]))
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  return [...new Set(paths)].filter((path) => hasFiles(join(worktree, path)));
}
function hasFiles(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Reached only by refs that outlive the worktree. A per-worktree ref such as
// refs/worktree/* or the worktree's HEAD is removed with it, so it does not count.
const unreached = (worktree, sha) =>
  git(worktree, ["for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes", "refs/stash"]).trim() === "";

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
    // Folders are named by local date, so read them as local midnight.
    const day = /^\d{4}-\d{2}-\d{2}$/.test(entry) ? Date.parse(`${entry}T00:00:00`) : NaN;
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
  // A branch-safe name: git refuses spaces, "..", a ".lock" suffix, and more.
  const name = basename(worktree).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/(\.lock|\.)+$/, "").replace(/^[-.]+/, "") || "worktree";
  const locked = lockedReason(worktree);
  if (locked) return { kind: "hold", worktree, reason: `locked: ${locked}` };
  const submodules = riskySubmodules(worktree);
  if (submodules.length) return { kind: "hold", worktree, reason: `submodules removal could lose work in: ${submodules.join(", ")}` };
  try {
    git(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return { kind: "hold", worktree, reason: "HEAD has no commit yet, so there is nothing to base a backup branch on" };
  }
  if (git(worktree, ["ls-files", "--unmerged"]).trim()) {
    return { kind: "hold", worktree, reason: "unmerged paths from a merge, rebase, or cherry-pick in progress" };
  }

  const result = { kind: "backed-up", worktree, branches: [], tarball: null, prunedTrash: pruneTrash(trash, keepDays, now) };
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();

  // Tracked changes, staged or not, as a commit on top of HEAD.
  if (git(worktree, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]).trim()) {
    const index = join(tmpdir(), `potluck-backup-index-${process.pid}-${now}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      // Like git stash: one commit for the index as staged, and one on top of it
      // for the files as they are on disk, so neither version is lost.
      copyFileSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim(), index);
      const staged = git(worktree, ["commit-tree", git(worktree, ["write-tree"], env).trim(), "-p", head, "-m", `wip: index of ${name} before worktree removal`]).trim();
      git(worktree, ["add", "--update", "--", "."], env);
      const tree = git(worktree, ["write-tree"], env).trim();
      const commit = git(worktree, ["commit-tree", tree, "-p", staged, "-m", `wip: backup of ${name} before worktree removal`]).trim();
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
  // Every untracked file is kept. Only ignored files under the audit's
  // DISPOSABLE build and cache directories are left, as the audit counts them.
  const others = z(git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const ignored = z(git(worktree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]))
    .filter((path) => !path.split("/").some((part) => DISPOSABLE.has(part)));
  const keep = [...new Set([...others, ...ignored])];
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
    const top = git(positionals[0], ["rev-parse", "--show-toplevel"]).trim();
    if (realpathSync(top) !== realpathSync(positionals[0])) {
      return process.stderr.write(`${positionals[0]} is inside a worktree, not its top level (${top}); pass the top level\n`), 2;
    }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.status) return process.stderr.write(`not a git worktree: ${positionals[0]}\n`), 2;
    throw error;
  }
  const result = backup(positionals[0], { trash, keepDays, date });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.kind === "hold" ? 3 : 0;
}

if (process.argv[1]?.endsWith("worktree-backup.mjs")) process.exitCode = main(process.argv.slice(2));
