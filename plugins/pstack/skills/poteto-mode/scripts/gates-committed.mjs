// potluck: whether a gates file holds changes nobody committed (third round
// answers, section D). Only the user changes one, and a tool the lock does not
// read, such as Codex's patch tool, can reach it, so the merge gate asks first.
//
// It reads the user's file, the repository's file, and each link on the way to
// either, following links as the system does, and compares the bytes with the
// commit and the index entry with the commit, so no filter, textconv, fsmonitor,
// or hook runs. Only a file with no `.git` above it, and one in a repository
// with no commit at all, have nothing to compare with and pass. Anything git
// cannot read is a reason to refuse.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import { REPO_FILE, userFile } from "./gates.mjs";

const lstat = (path) => lstatSync(path, { throwIfNoEntry: false });

// git on the repository at `top`, with the caller's GIT_* variables dropped so
// none points it elsewhere, and nothing replaced or fetched. `ok` is whether it
// exited 0 without a warning.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
function git(top, ...args) {
  const r = spawnSync("git", ["-C", top, `--git-dir=${join(top, ".git")}`, `--work-tree=${top}`, "-c", "core.fsmonitor=false", ...args], { env, timeout: 60_000, maxBuffer: Infinity });
  return { ok: r.status === 0 && !r.stderr.length, out: r.stdout?.toString("latin1") ?? "", error: String(r.error?.message ?? r.stderr).trim().split("\n")[0] };
}
function read(top, ...args) {
  const r = git(top, ...args);
  if (!r.ok) throw new Error(r.error || `git ${args[0]} failed`);
  return r.out;
}

// `path` as the system opens it: each link on the way, then where it ends, with
// the names as they are on disk, case included.
function trail(path) {
  const links = [];
  let at = parse(path).root;
  const rest = path.slice(at.length).split(sep);
  while (rest.length) {
    const part = rest.shift();
    if (part === "" || part === ".") continue;
    const next = part === ".." ? dirname(at) : join(at, part);
    const stat = lstat(next);
    if (!stat?.isSymbolicLink()) {
      at = stat && part !== ".." ? join(at, basename(realpathSync.native(next))) : next;
      continue;
    }
    if (links.length > 40) throw new Error("too many links");
    const name = readdirSync(at).find((entry) => entry === part) ?? readdirSync(at).find((entry) => lstat(join(at, entry))?.ino === stat.ino) ?? part;
    links.push(join(at, name));
    const target = readlinkSync(next);
    if (isAbsolute(target)) at = parse(target).root;
    rest.unshift(...target.slice(isAbsolute(target) ? at.length : 0).split(sep));
  }
  return [...links, at];
}

// The folder above `path` that has a `.git`, or null.
function repository(path) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (lstat(join(dir, ".git"))) return dir;
    if (dir === dirname(dir)) return null;
  }
}

// Why the file at `path` is not as committed, or null. A missing one counts when
// the commit or the index has it, a folder in its place, or a link or submodule
// above it, whatever the letter case, since the disk no longer tells the name.
function uncommitted(path) {
  const top = repository(path);
  if (!top) return null;
  if (!git(top, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").ok) {
    const refs = read(top, "for-each-ref");
    const objects = read(top, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)");
    if (refs || /^commit$/m.test(objects)) throw new Error("HEAD names no commit in a repository that has some");
    return null;
  }
  const name = relative(top, path).split(sep).join("/");
  const stat = lstat(path);
  if (!stat) {
    const fold = (text) => text.normalize("NFC").toLowerCase();
    const names = fold(Buffer.from(read(top, "ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD") + read(top, "ls-files", "-z"), "latin1").toString()).split("\0");
    return names.some((held) => held && `${fold(name)}/`.startsWith(`${held}/`) || held.startsWith(`${fold(name)}/`)) ? `${path} has uncommitted changes` : null;
  }
  // `<mode> blob <oid>` in the commit, `<mode> <oid> <stage>` in the index.
  const commit = read(top, "ls-tree", "-z", "--full-tree", "HEAD", "--", name).split("\t")[0];
  const index = read(top, "ls-files", "-s", "-z", "--", name).split("\t")[0];
  const [mode, type, oid] = commit.split(" ");
  const same = type === "blob" && index === `${mode} ${oid} 0` && (mode === "120000") === stat.isSymbolicLink();
  if (!same) return `${path} has uncommitted changes`;
  const bytes = stat.isSymbolicLink() ? readlinkSync(path, "buffer") : readFileSync(path);
  // A checkout may convert line endings, which mean nothing in JSON.
  const lines = (text) => text.replaceAll("\r\n", "\n");
  return lines(bytes.toString("latin1")) === lines(read(top, "cat-file", "blob", `HEAD:${name}`)) ? null : `${path} has uncommitted changes`;
}

// One reason for each gates file that is not as committed, for the repository
// the checkout at `root` holds.
export function gatesNotCommitted(root, user = userFile()) {
  const reasons = new Set();
  for (const file of [user, join(root, REPO_FILE)]) {
    let path = file;
    try {
      for (path of trail(file)) reasons.add(uncommitted(path));
    } catch (error) {
      reasons.add(`whether ${path} has uncommitted changes could not be read: ${error.message.split("\n")[0]}`);
    }
  }
  return [...reasons].filter(Boolean);
}
