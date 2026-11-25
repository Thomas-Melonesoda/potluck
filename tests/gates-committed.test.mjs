// potluck: gates-committed.mjs on real repositories; merge-gate.test.mjs covers
// the refusal through the gate.
import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const module = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/gates-committed.mjs");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const dirs = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A repository `notes` that has `notes/Mine.json` committed, and `ask`, which
// runs the check with `user` as the user's file.
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "potluck-committed-")));
  dirs.push(dir);
  const [notes, file] = [join(dir, "notes"), join(dir, "notes/Mine.json")];
  mkdirSync(notes);
  const git = (...args) => execFileSync("git", ["-C", notes, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const commit = () => (git("add", "."), git("commit", "-q", "-m", "x"));
  git("init", "-q", "-b", "main");
  writeFileSync(file, '{"a": 1}\n');
  commit();
  const ask = (user = file, env = {}) => {
    const r = spawnSync("node", ["--input-type=module", "-e", `import { gatesNotCommitted } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(gatesNotCommitted(${JSON.stringify(dir)}, ${JSON.stringify(user)})))`], { encoding: "utf8", env: { ...process.env, HOME: dir, ...env } });
    return JSON.parse(r.stdout);
  };
  const change = () => writeFileSync(file, '{"a": 2}\n');
  return { dir, notes, file, git, commit, ask, change };
}
const changed = [expect.stringContaining("has uncommitted changes")];
const unread = [expect.stringContaining("could not be read")];

test("a committed file passes, and a changed or untracked one, or one whose index entry differs, is named", () => {
  const s = setup();
  expect(s.ask()).toEqual([]);
  writeFileSync(s.file, '{"a": 1}\r\n');
  expect(s.ask()).toEqual([]); // a checkout converts line endings
  s.change();
  expect(s.ask()).toEqual([`${s.file} has uncommitted changes`]);
  s.git("add", ".");
  writeFileSync(s.file, '{"a": 1}\n');
  expect(s.ask()).toEqual(changed);
  const other = join(s.notes, "new.json");
  writeFileSync(other, "{}");
  expect(s.ask(other)).toEqual([`${other} has uncommitted changes`]);
  writeFileSync(join(s.notes, ".gitignore"), "new.json\n");
  expect(s.ask(other)).toEqual([`${other} has uncommitted changes`]);
  expect(s.ask(join(s.notes, "none.json"))).toEqual([]);
});

test("no clean filter, filter process, or fsmonitor runs, and none hides a change", () => {
  for (const config of ["filter.x.clean", "filter.x.process", "core.fsmonitor"]) {
    const s = setup();
    const [marker, script] = [join(s.dir, "ran"), join(s.dir, "run.sh")];
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nprintf '{"a": 1}\\n'\n`, { mode: 0o755 });
    s.git("config", config, script);
    writeFileSync(join(s.notes, ".git/info/attributes"), "*.json filter=x\n");
    utimesSync(s.file, 1, 1);
    expect([config, s.ask(), existsSync(marker)]).toEqual([config, [], false]);
    s.change();
    expect([config, s.ask(), existsSync(marker)]).toEqual([config, changed, false]);
  }
});

test("a link whose target differs in letter case reads the file the system opens", () => {
  const s = setup();
  if (!existsSync(join(s.notes, "mine.json"))) return;
  const link = join(s.dir, "link.json");
  symlinkSync(join(s.notes, "mine.json"), link);
  expect(s.ask(link)).toEqual([]);
  s.change();
  expect(s.ask(link)).toEqual([`${s.file} has uncommitted changes`]);
});

test.each([
  ["an unreadable .git", (s) => chmodSync(join(s.notes, ".git"), 0)],
  ["no HEAD", (s) => rmSync(join(s.notes, ".git/HEAD"))],
  ["a corrupt branch", (s) => writeFileSync(join(s.notes, ".git/refs/heads/main"), "junk\n")],
  ["a missing branch", (s) => rmSync(join(s.notes, ".git/refs/heads/main"))],
  ["a corrupt branch and no objects", (s) => (writeFileSync(join(s.notes, ".git/refs/heads/main"), "junk\n"), rmSync(join(s.notes, ".git/objects"), { recursive: true }), mkdirSync(join(s.notes, ".git/objects")))],
  ["an orphan branch", (s) => s.git("symbolic-ref", "HEAD", "refs/heads/new")],
  ["a gitdir that is gone", (s) => (rmSync(join(s.notes, ".git"), { recursive: true }), writeFileSync(join(s.notes, ".git"), "gitdir: /nowhere/at/all\n"))],
  ["an empty .git", (s) => (rmSync(join(s.notes, ".git"), { recursive: true }), mkdirSync(join(s.notes, ".git")))],
])("%s refuses", (_, breakIt) => {
  const s = setup();
  s.change();
  breakIt(s);
  const reasons = s.ask();
  chmodSync(join(s.notes, ".git"), 0o755);
  expect(reasons).toEqual(unread);
});

test("a linked worktree is compared with its own commit", () => {
  const s = setup();
  const tree = join(s.dir, "tree");
  s.git("worktree", "add", "-q", "-b", "side", tree);
  expect(s.ask(join(tree, "Mine.json"))).toEqual([]);
  writeFileSync(join(tree, "Mine.json"), "{}");
  expect([s.ask(join(tree, "Mine.json")), s.ask()]).toEqual([changed, []]);
});

test("a file outside git and one in a repository with no commit pass", () => {
  const s = setup();
  const loose = join(s.dir, "loose.json");
  writeFileSync(loose, "{}");
  expect(s.ask(loose)).toEqual([]);
  rmSync(join(s.notes, ".git"), { recursive: true });
  s.git("init", "-q", "-b", "main");
  s.git("add", ".");
  expect(s.ask()).toEqual([]);
});

test("links are followed through folders and long chains, and a loop refuses", () => {
  const s = setup();
  mkdirSync(join(s.dir, "far/deep"), { recursive: true });
  renameSync(s.notes, join(s.dir, "far/notes"));
  symlinkSync(join(s.dir, "far/deep"), join(s.dir, "folder"));
  symlinkSync("folder/../notes/Mine.json", join(s.dir, "dots.json"));
  symlinkSync("dots.json", join(s.dir, "0.json"));
  for (let i = 1; i < 20; i++) symlinkSync(`${i - 1}.json`, join(s.dir, `${i}.json`));
  const far = join(s.dir, "far/notes/Mine.json");
  for (const link of ["dots.json", "19.json"]) {
    writeFileSync(far, '{"a": 1}\n');
    expect(s.ask(join(s.dir, link))).toEqual([]);
    writeFileSync(join(s.dir, link), '{"a": 2}\n');
    expect(s.ask(join(s.dir, link))).toEqual([`${far} has uncommitted changes`]);
  }
  symlinkSync("loop.json", join(s.dir, "loop.json"));
  expect(s.ask(join(s.dir, "loop.json"))).toEqual(unread);
});

test("a link kept in git refuses once it points elsewhere, and a deleted target once it is gone", () => {
  const s = setup();
  const link = join(s.notes, "link.json");
  symlinkSync("Mine.json", link);
  s.commit();
  expect(s.ask(link)).toEqual([]);
  rmSync(link);
  symlinkSync(join(s.dir, "elsewhere.json"), link);
  expect(s.ask(link)).toEqual([`${link} has uncommitted changes`]);
  const sub = join(s.notes, "a/b/deep.json");
  mkdirSync(join(s.notes, "a/b"), { recursive: true });
  writeFileSync(sub, "{}");
  s.commit();
  writeFileSync(sub, '{"a": 2}');
  expect(s.ask(sub)).toEqual([`${sub} has uncommitted changes`]);
  rmSync(sub);
  symlinkSync("{}", sub);
  writeFileSync(join(s.notes, "a/b/{}"), '{"a": 2}');
  expect(s.ask(sub)[0]).toBe(`${sub} has uncommitted changes`);
  symlinkSync(s.notes, join(s.dir, "folder"));
  rmSync(s.file);
  expect(s.ask(join(s.dir, "folder/Mine.json"))).toEqual([`${s.file} has uncommitted changes`]);
});

// What is missing, asked by any case, where git holds it, a link above it, or a submodule above it.
test.each([
  ["a file by another case", "mine.JSON", (s) => rmSync(s.file)],
  ["a file removed from the index too", "MINE.json", (s) => s.git("rm", "-q", "Mine.json")],
  ["a staged file", "NEW.json", (s) => (writeFileSync(join(s.notes, "new.json"), ""), s.git("add", "."), rmSync(join(s.notes, "new.json")))],
  ["a folder by another case", "A/b.json", (s) => rmSync(join(s.notes, "a"), { recursive: true })],
  ["a link by another case", "LINK.json", (s) => rmSync(join(s.notes, "link.json"))],
  ["a folder link", "d/Mine.json", (s) => rmSync(join(s.notes, "d"))],
  ["a folder link replaced by a folder", "D/Mine.json", (s) => (rmSync(join(s.notes, "d")), mkdirSync(join(s.notes, "d")))],
  ["a folder where the file was asked", "a", (s) => rmSync(join(s.notes, "a"), { recursive: true })],
  ["a submodule's folder", "sub/Mine.json", (s) => rmSync(join(s.notes, "sub"), { recursive: true, force: true })],
])("%s, once gone, refuses", (_, name, remove) => {
  const s = setup();
  mkdirSync(join(s.notes, "a"));
  writeFileSync(join(s.notes, "a/b.json"), "{}");
  symlinkSync("Mine.json", join(s.notes, "link.json"));
  symlinkSync("a", join(s.notes, "d"));
  s.git("update-index", "--add", "--cacheinfo", `160000,${s.git("rev-parse", "HEAD").trim()},sub`);
  s.git("add", "a", "d", "link.json");
  s.git("commit", "-q", "-m", "x");
  for (const other of ["a/none.json", "b/none.json", "Mine.json.old"]) expect(s.ask(join(s.notes, other))).toEqual([]);
  remove(s);
  expect(s.ask(join(s.notes, name))).toEqual(changed);
});

test.each(["update-index --assume-unchanged Mine.json", "update-index --skip-worktree Mine.json", "config core.bare true", "config core.worktree /"])("git %s does not hide a change", (args) => {
  const s = setup();
  s.git(...args.split(" "));
  expect(s.ask()).toEqual([]);
  s.change();
  expect(s.ask()).toEqual(changed);
});

test("the caller's GIT_* variables, replace refs, and other configuration do not reach it", () => {
  const s = setup();
  const env = { GIT_INDEX_FILE: join(s.dir, "none"), GIT_OBJECT_DIRECTORY: join(s.dir, "none"), GIT_DIR: join(s.dir, "none") };
  expect(s.ask(s.file, env)).toEqual([]);
  s.change();
  s.git("replace", s.git("rev-parse", "HEAD:Mine.json").trim(), s.git("hash-object", "-w", "Mine.json").trim());
  expect(s.ask(s.file, env)).toEqual(changed);
});
