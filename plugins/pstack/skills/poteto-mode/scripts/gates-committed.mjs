// potluck: whether a gates file holds changes nobody committed (second and
// third round answers, section D). Only the user changes and commits a gates
// file, and a file-editing tool the lock does not read, such as Codex's patch
// tool, can still reach one. The merge gate asks this before it merges, so the
// user sees such a change before it counts.
//
// It reads the user's file, the repository's file, and the file each links to,
// in the git repository that holds it. A file outside any repository, one in a
// repository with no commit yet, and one git ignores have no history to compare
// with and pass.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { REPO_FILE, userFile } from "./gates.mjs";

// git with the caller's GIT_* variables dropped, so none points it elsewhere,
// and with fsmonitor off, so the answer comes from the files.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), LC_ALL: "C" };
const git = (dir, args) => execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-C", dir, "-c", "core.fsmonitor=false", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

// `path`, then each file it links to.
function chain(path) {
  const files = [];
  for (let at = path; !files.includes(at) && files.length < 10; ) {
    files.push(at);
    if (!lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) break;
    const target = readlinkSync(at);
    at = isAbsolute(target) ? target : resolve(dirname(at), target);
  }
  return files;
}

// Why the file at `path` is not as committed, or null. A missing one counts
// when its repository has it committed.
function uncommitted(path) {
  let dir = dirname(path);
  while (!existsSync(dir)) dir = dirname(dir);
  try {
    git(dir, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (/not a git repository|must be run in a work tree/.test(String(error.stderr))) return null;
    throw error;
  }
  try {
    git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return null;
  }
  const name = relative(dir, path);
  if (git(dir, ["status", "--porcelain", "--untracked-files=all", "--", name]).trim()) return `${path} has uncommitted changes`;
  // git status says nothing of a file marked assume-unchanged (a lowercase
  // letter) or skip-worktree (S).
  if (/^(?:[a-z]|S) /.test(git(dir, ["ls-files", "-v", "--", name]))) return `${path} is marked so that git ignores changes to it`;
  return null;
}

// One reason for each gates file that is not as committed, for the repository
// the checkout at `root` holds.
export function gatesNotCommitted(root, user = userFile()) {
  const paths = new Set([user, join(root, REPO_FILE)].flatMap(chain));
  return [...paths].map((path) => {
    try {
      return uncommitted(path);
    } catch (error) {
      return `whether ${path} has uncommitted changes could not be read: ${String(error.stderr || error.message).trim().split("\n")[0]}`;
    }
  }).filter(Boolean);
}
