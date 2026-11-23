#!/usr/bin/env node
// potluck: delete a worktree so the deletion can be undone (design row S3-C3,
// with the safeguards of stage 5 issue 6).
//
//   node worktree-remove.mjs <worktree-path> [--trash <dir>] [--keep-days <n>] [--date <YYYY-MM-DD>]
//
// It refuses (exit 2) a path that is not the top level of a linked worktree git
// lists, so the main checkout, a folder inside a worktree, and anything outside
// every worktree are never touched, and a trash inside the worktree. Then:
//   1. worktree-backup.mjs backs the worktree up; its hold stops here
//   2. the backup is checked: each backup branch exists and points at the
//      commit the backup made, and the tarball holds the same files, at the same
//      sizes, as the worktree has on disk now; any mismatch holds the worktree
//   3. the worktree moves to <trash>/<date>/<name>-<time>, never `rm -rf`, its
//      .git file is renamed so it no longer points at git's record, and git
//      drops that one record. The backup clears date folders older than
//      --keep-days, moved worktrees with them, and reports any it cannot.
// Prints one JSON line. Exit 0 removed, 3 hold, 2 refused or usage.

import { execFileSync } from "node:child_process";
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";

import { backup, keptFiles, parseCli } from "./worktree-backup.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity });
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
// A path's real location, read through the nearest folder that exists.
function realPath(path) {
  const rest = [];
  let head = resolve(path);
  while (!exists(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}
const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// The worktree's real top level, the path git records for it, and its
// repository's git directory, or why the path may not be touched. It reads the
// worktree's own files, never `git worktree list`, whose text a path with a
// newline can forge (and whose -z form needs git 2.36).
function linkedWorktree(path) {
  const realOf = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const not = { refused: `${path} is not the top level of a linked worktree` };
  // One path per call, with only git's own line end cut, so a newline in a path survives.
  const ask = (dir, what) => git(dir, ["rev-parse", "--path-format=absolute", what]).replace(/\n$/, "");
  let real;
  let top;
  let gitDir;
  let common;
  try {
    real = realpathSync(path);
    top = ask(real, "--show-toplevel");
    gitDir = ask(real, "--git-dir");
    common = ask(real, "--git-common-dir");
  } catch {
    return { refused: `${path} is not the top level of a linked worktree: git finds no worktree there` };
  }
  if (realOf(top) !== real) return not;
  if (realOf(gitDir) === realOf(common)) return { refused: `${path} is the main worktree, which holds the repository itself` };
  // git's record of a linked worktree is <common>/worktrees/<id>, and its
  // gitdir file names the .git file in the folder git records.
  if (realOf(dirname(gitDir)) !== realOf(join(common, "worktrees"))) return not;
  let recorded;
  try {
    recorded = dirname(readFileSync(join(gitDir, "gitdir"), "utf8").replace(/\n$/, ""));
  } catch {
    return not;
  }
  if (realOf(recorded) !== real) return not;
  if (lstatSync(recorded).isSymbolicLink()) return { refused: `the path git records for ${path} is a symlink; run git worktree repair on the real folder first` };
  if (inside(real, realOf(common))) return { refused: `${path} holds the repository's git directory` };
  return { real, common, recorded };
}

// Each file under the given paths as it is on disk, folders walked: path ->
// "<size> bytes" or "link to <target>", the form tarFiles reads.
function diskFiles(worktree, paths) {
  const files = new Map();
  const visit = (rel) => {
    const stat = lstatSync(join(worktree, rel));
    if (stat.isSymbolicLink()) files.set(rel, `link to ${readlinkSync(join(worktree, rel))}`);
    else if (stat.isDirectory()) for (const name of readdirSync(join(worktree, rel))) visit(join(rel, name));
    else if (stat.isFile()) files.set(rel, `${stat.size} bytes`);
  };
  for (const path of paths) visit(path.replace(/\/+$/, ""));
  return files;
}

// The files a .tar.gz holds, read from its headers (ustar, pax, and GNU long
// names) without unpacking it: path -> "<size> bytes" or "link to <target>".
async function tarFiles(file) {
  const files = new Map();
  const text = (block, at, length) => {
    const field = block.subarray(at, at + length);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  const padded = (size) => Math.ceil(size / 512) * 512;
  let buffer = Buffer.alloc(0);
  let skip = 0;
  let meta = null;
  let next = {};
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (skip) {
        const n = Math.min(skip, buffer.length);
        buffer = buffer.subarray(n);
        skip -= n;
        if (skip) break;
      }
      if (meta) {
        if (buffer.length < padded(meta.size)) break;
        const body = buffer.subarray(0, meta.size).toString("utf8");
        buffer = buffer.subarray(padded(meta.size));
        if (meta.type === "x") for (const [, key, value] of body.matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) next[key] = value;
        else next[meta.type === "L" ? "path" : "linkpath"] = body.replace(/\0+$/, "");
        meta = null;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) continue;
      const type = header[156] ? String.fromCharCode(header[156]) : "0";
      const own = header[124] & 0x80 ? Number(header.readBigUInt64BE(128)) : parseInt(text(header, 124, 12).trim() || "0", 8);
      if (["x", "L", "K"].includes(type)) {
        meta = { type, size: own };
        continue;
      }
      if (type === "g") {
        skip = padded(own);
        continue;
      }
      const size = next.size === undefined ? own : Number(next.size);
      // bsdtar stores a sparse file under a GNU.sparse name, with its real size.
      const real = next["GNU.sparse.realsize"] ?? next["GNU.sparse.size"];
      const prefix = text(header, 257, 5) === "ustar" ? text(header, 345, 155) : "";
      const path = (next["GNU.sparse.name"] ?? next.path ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))).replace(/^\.\//, "").replace(/\/+$/, "");
      const link = next.linkpath ?? text(header, 157, 100);
      next = {};
      skip = padded(size);
      if (type === "0" || type === "7") files.set(path, `${real === undefined ? size : Number(real)} bytes`);
      else if (type === "1") files.set(path, files.get(link.replace(/^\.\//, "")) ?? "a hard link");
      else if (type === "2") files.set(path, `link to ${link}`);
    }
  }
  return files;
}

// What does not match between the backup and the worktree, as sentences.
async function backupProblems(worktree, result) {
  const problems = [];
  for (const { branch, commit } of result.branches) {
    let at;
    try {
      at = git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).trim();
    } catch {
      at = "";
    }
    if (at !== commit) problems.push(`backup branch ${branch} ${at ? `points at ${at}` : "is missing"}, not at ${commit}`);
  }
  const want = diskFiles(worktree, keptFiles(worktree));
  const have = result.tarball ? await tarFiles(result.tarball.path) : new Map();
  // macOS tar stores a file's or folder's extended attributes as a "._<name>"
  // entry beside it, which is no file of its own.
  for (const path of [...have.keys()]) {
    const sibling = /^(.*\/)?\._([^/]+)$/.exec(path);
    if (sibling && !exists(join(worktree, path)) && exists(join(worktree, `${sibling[1] ?? ""}${sibling[2]}`))) have.delete(path);
  }
  if (want.size !== have.size) problems.push(`the tarball holds ${have.size} files and the worktree has ${want.size}`);
  const differ = [...new Set([...want.keys(), ...have.keys()])].filter((path) => want.get(path) !== have.get(path));
  for (const path of differ.slice(0, 5)) problems.push(`${path}: ${want.get(path) ?? "missing"} on disk, ${have.get(path) ?? "missing"} in the tarball`);
  return problems;
}

// Moves a worktree that `result` backed up into the trash, once the backup
// checks out. `options` are the backup's: trash, date, and now.
export async function removeBackedUp(worktree, result, { trash, date, now = Date.now() }) {
  const where = linkedWorktree(worktree);
  if (where.refused) return { kind: "hold", worktree, reason: where.refused };
  const problems = await backupProblems(where.real, result);
  if (problems.length) return { kind: "hold", worktree, reason: `the backup does not match the worktree, so it was not removed: ${problems.join("; ")}`, backup: result };
  const dir = join(trash, date);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const trashed = join(dir, `${basename(where.real)}-${now}`);
  try {
    renameSync(where.real, trashed);
  } catch (error) {
    return { kind: "hold", worktree, reason: `could not move it to the trash (${error.code ?? error.message}); a trash on the worktree's own volume can take it`, backup: result };
  }
  // The folder's .git file points at git's record of the worktree, which a new
  // worktree of the same name would reuse, so the trashed copy stops pointing.
  if (exists(join(trashed, ".git"))) {
    let name = ".git.removed";
    for (let n = 2; exists(join(trashed, name)); n++) name = `.git.removed-${n}`;
    renameSync(join(trashed, ".git"), join(trashed, name));
  }
  // Only this worktree's record goes; `git worktree prune` would also drop the
  // record of any other worktree whose folder is missing. The path is gone, so
  // this removes nothing on disk.
  let recordKept;
  try {
    if (exists(where.recorded)) throw new Error(`${where.recorded} exists again`);
    execFileSync("git", ["--git-dir", where.common, "worktree", "remove", "--force", where.recorded], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // The folder is already in the trash; a record git keeps is only reported.
    recordKept = String(error.stderr || error.message).trim().split("\n")[0];
  }
  return { kind: "removed", worktree, trashed, ...(recordKept && { recordKept }), backup: result };
}

export async function main(argv) {
  const cli = parseCli(argv, "usage: worktree-remove.mjs <worktree-path> [--trash <dir>] [--keep-days <n>] [--date <YYYY-MM-DD>]\n");
  if (typeof cli === "number") return cli;
  const where = linkedWorktree(cli.path);
  if (where.refused) return process.stderr.write(`refused: ${where.refused}\n`), 2;
  let trash;
  try {
    trash = realPath(cli.trash);
  } catch (error) {
    return process.stderr.write(`refused: cannot read the trash path ${cli.trash} (${error.code ?? error.message})\n`), 2;
  }
  if (inside(where.real, trash)) return process.stderr.write(`refused: the trash ${cli.trash} is inside the worktree\n`), 2;
  // The trash clears expired date folders first, which would take a worktree inside one.
  if (inside(trash, where.real)) return process.stderr.write(`refused: the worktree is inside the trash ${cli.trash}\n`), 2;
  const now = Date.now();
  const backedUp = backup(cli.path, { ...cli, now });
  const result = backedUp.kind === "hold" ? backedUp : await removeBackedUp(cli.path, backedUp, { ...cli, now });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.kind === "removed" ? 0 : 3;
}

if (process.argv[1]?.endsWith("worktree-remove.mjs")) process.exitCode = await main(process.argv.slice(2));
