// potluck: the operator's gates file (stage 5 design answers) in
// plugins/pstack/skills/poteto-mode/scripts/gates.mjs. Two files apply, the
// user's and the repository's, and for each gate the stricter value wins.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGates, parseGates, REPO_FILE, strictest } from "../plugins/pstack/skills/poteto-mode/scripts/gates.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/gates.mjs");
const dirs = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A home and a repository root, each with its gates file when given.
function setup({ user, repo } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "potluck-gates-")));
  dirs.push(dir);
  const home = join(dir, "home");
  const root = join(dir, "repo");
  mkdirSync(join(home, ".potluck"), { recursive: true });
  mkdirSync(join(root, ".potluck"), { recursive: true });
  if (user !== undefined) writeFileSync(join(home, ".potluck/gates.json"), typeof user === "string" ? user : JSON.stringify(user));
  if (repo !== undefined) writeFileSync(join(root, REPO_FILE), typeof repo === "string" ? repo : JSON.stringify(repo));
  const cli = (...args) => spawnSync("node", [script, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home } });
  return { home, root, user: join(home, ".potluck/gates.json"), repo: join(root, REPO_FILE), cli };
}

describe("parseGates", () => {
  test("every key parses", () => {
    const text = JSON.stringify({ noCI: "wait", foreignRepos: "ask", askFirst: ["publishing a release"] });
    expect(parseGates(text, "f")).toEqual({ noCI: "wait", foreignRepos: "ask", askFirst: ["publishing a release"] });
  });

  test.each([
    ["{", "f: not valid JSON"],
    ["[]", "f: must be a JSON object"],
    ['{"noCi": "wait"}', 'f: unknown key "noCi"; the keys are noCI, foreignRepos, askFirst'],
    ['{"noCI": "never"}', 'f: noCI must be "merge" or "wait", not "never"'],
    ['{"foreignRepos": true}', 'f: foreignRepos must be "allow" or "ask", not true'],
    ['{"askFirst": "spending money"}', "f: askFirst must be a list of non-empty strings"],
    ['{"askFirst": [" "]}', "f: askFirst must be a list of non-empty strings"],
  ])("a typo fails instead of dropping a gate: %s", (text, message) => {
    expect(() => parseGates(text, "f")).toThrow(message);
  });
});

describe("strictest", () => {
  test("with no file, potluck's defaults hold", () => {
    expect(strictest([])).toEqual({ noCI: "merge", foreignRepos: "allow", askFirst: [], from: {} });
  });

  test("the stricter value wins whichever file sets it", () => {
    const user = { source: "user", gates: { noCI: "wait", foreignRepos: "allow" } };
    const repo = { source: "repo", gates: { noCI: "merge", foreignRepos: "ask" } };
    for (const layers of [[user, repo], [repo, user]]) {
      const gates = strictest(layers);
      expect([gates.noCI, gates.from.noCI]).toEqual(["wait", "user"]);
      expect([gates.foreignRepos, gates.from.foreignRepos]).toEqual(["ask", "repo"]);
    }
  });

  test("askFirst items from both files apply, each once", () => {
    const gates = strictest([
      { source: "user", gates: { askFirst: ["spending money", "publishing a release"] } },
      { source: "repo", gates: { askFirst: [" spending money", "deleting a branch"] } },
    ]);
    expect(gates.askFirst).toEqual(["spending money", "publishing a release", "deleting a branch"]);
  });
});

describe("loadGates", () => {
  test("reads the user's file and the repository's, and a repository file cannot loosen the user's", () => {
    const s = setup({ user: { noCI: "wait" }, repo: { noCI: "merge", foreignRepos: "ask" } });
    const gates = loadGates({ root: s.root, user: s.user });
    expect(gates).toMatchObject({ noCI: "wait", foreignRepos: "ask", from: { noCI: s.user, foreignRepos: s.repo } });
  });

  test("missing files leave the defaults, and a broken one throws naming its path", () => {
    const none = setup();
    expect(loadGates({ root: none.root, user: none.user })).toMatchObject({ noCI: "merge", foreignRepos: "allow" });
    const broken = setup({ repo: '{"noCI": "later"}' });
    expect(() => loadGates({ root: broken.root, user: broken.user })).toThrow(`${broken.repo}: noCI must be`);
  });
});

describe("gates.mjs CLI, as poteto-mode reads it at the start of a run", () => {
  test("with no gates it says potluck's defaults apply", () => {
    const r = setup().cli();
    expect([r.status, r.stdout]).toEqual([0, "No operator's gates: potluck's defaults apply.\n"]);
  });

  test("prints each gate in force with the file that set it, then each askFirst item", () => {
    const s = setup({ user: { noCI: "wait", askFirst: ["spending money"] }, repo: { foreignRepos: "ask" } });
    const r = s.cli();
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("The operator's gates, stricter than potluck's defaults:");
    expect(lines[1]).toStartWith(`- noCI: wait (${s.user}). A PR with no CI result`);
    expect(lines[2]).toStartWith(`- foreignRepos: ask (${s.repo}). A gh command that writes to a repository`);
    expect(lines[3]).toBe("- Ask the user first: spending money");
  });

  test("importing it from another script whose name ends in gates.mjs prints nothing", () => {
    const s = setup({ user: { noCI: "wait" } });
    const importer = join(s.root, "operator-gates.mjs");
    writeFileSync(importer, `import ${JSON.stringify(script)};\n`);
    const r = spawnSync("node", [importer], { encoding: "utf8", env: { ...process.env, HOME: s.home } });
    expect([r.status, r.stdout]).toEqual([0, ""]);
  });

  test("--root names the repository, and a broken file exits 1 with its error", () => {
    const s = setup({ repo: '{"noCI": "wait",}' });
    const r = spawnSync("node", [script, "--root", s.root], { encoding: "utf8", env: { ...process.env, HOME: s.home } });
    expect(r.status).toBe(1);
    expect(r.stderr).toStartWith(`${s.repo}: not valid JSON`);
  });
});
