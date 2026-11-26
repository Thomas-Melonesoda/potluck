// potluck: the co-sign reading in CI's "Quality floor and overview" job. The
// step's own script from .github/workflows/ci.yml runs on a scratch repository,
// with a fake `gh` that returns the PR's comments, so these cases test the
// workflow as written.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const step = workflow.jobs.floor.steps.find((s) => s.name === "Check the floor and the overview against the base");
// The files the step runs from the base's checkout.
const TOOLS = [
  "plugins/pstack/skills/poteto-mode/scripts/floor.mjs",
  "plugins/pstack/skills/constraint-driven-development/references/floor-guard.md",
  "plugins/pstack/skills/grill/scripts/overview.mjs",
];
const TEST = "src/app.test.js";
const TWO = `test("adds", () => {\n  ${"expect"}(1 + 1).toBe(2);\n  ${"expect"}(2 + 2).toBe(4);\n});\n`;

describe("the floor job's co-sign reading", () => {
  const dirs = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

  // A base that holds the job's tools and a test, and a head that changes one of its assertions.
  function repo() {
    const work = mkdtempSync(join(tmpdir(), "potluck-floor-ci-"));
    dirs.push(work);
    git(work, "init", "-q", "-b", "main");
    for (const file of TOOLS) {
      mkdirSync(join(work, dirname(file)), { recursive: true });
      copyFileSync(join(root, file), join(work, file));
    }
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, TEST), TWO);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    const base = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, TEST), TWO.replace("toBe(4)", "toBe(5)"));
    git(work, "commit", "-q", "-am", "change");
    return { work, base, head: git(work, "rev-parse", "HEAD") };
  }

  // Runs the step with a fake gh that answers the comments call with `comments`, as one page.
  function runStep({ work, base, head }, comments) {
    const dir = mkdtempSync(join(tmpdir(), "potluck-floor-ci-gh-"));
    dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "temp"));
    writeFileSync(join(dir, "pages.json"), JSON.stringify([comments]));
    writeFileSync(join(dir, "bin/gh"), `#!/bin/sh\ncat ${JSON.stringify(join(dir, "pages.json"))}\n`, { mode: 0o755 });
    const env = { ...gitEnv, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_TOKEN: "x", REPO: "o/r", PR: "7", BASE_SHA: base, HEAD_SHA: head, RUNNER_TEMP: join(dir, "temp") };
    const r = spawnSync("bash", ["-c", step.run], { cwd: work, env, encoding: "utf8" });
    const line = r.stdout.trim().split("\n").at(-1);
    return { status: r.status, json: line?.startsWith("{") ? JSON.parse(line) : null, stderr: r.stderr };
  }

  const fingerprintOf = (r) => runStep(r, []).json.cosign;

  test("without a co-sign, the changed assertion fails the job", () => {
    const r = runStep(repo(), []);
    expect(r.status).toBe(1);
    expect(r.json.cosign).toMatch(/^[0-9a-f]{16}$/);
  }, 30_000);

  test("a whole-line marker from the owner is accepted", () => {
    const r = repo();
    const body = `Co-signed: the sums now round up, per the verifier's run.\r\npotluck-cosign: ${r.head} ${fingerprintOf(r)}\r\n`;
    expect(runStep(r, [{ author_association: "OWNER", body }]).status).toBe(0);
  }, 30_000);

  test("a comment by someone who is not a collaborator is ignored", () => {
    const r = repo();
    const body = `potluck-cosign: ${r.head} ${fingerprintOf(r)}`;
    expect(runStep(r, [{ author_association: "NONE", body }, { author_association: "CONTRIBUTOR", body }]).status).toBe(1);
    expect(runStep(r, [{ author_association: "MEMBER", body }]).status).toBe(0);
    expect(runStep(r, [{ author_association: "COLLABORATOR", body }]).status).toBe(0);
  }, 60_000);

  test("a marker quoted inside a longer line is ignored, and so is one for another head", () => {
    const r = repo();
    const fp = fingerprintOf(r);
    const quoted = `The job said: \`potluck-cosign: ${r.head} ${fp}\``;
    const indented = `    potluck-cosign: ${r.head} ${fp}`;
    const other = `potluck-cosign: ${"b".repeat(40)} ${fp}`;
    expect(runStep(r, [quoted, indented, other].map((body) => ({ author_association: "OWNER", body }))).status).toBe(1);
  }, 30_000);
});
