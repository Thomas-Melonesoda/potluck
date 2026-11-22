// potluck: `bun tools/sync.mjs revert <component> <path>` puts one forked file
// back to its upstream version and drops its tools/forks.json entry.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { revertedForm } from "../tools/sync.mjs";
import { cleanUp, fixtureRoot, port, upstreamRepo } from "./sync-fixture.mjs";

afterAll(cleanUp);

const path = "plugins/pstack/skills/a/notes.md";
const entry = { kind: "policy", why: "Fixture fork.", since: "0.9.48", upstream: "not-proposed" };

function setup({ upstreamText = "use the Task tool\n", exclude = [], denylist = [] } = {}) {
  const root = fixtureRoot();
  const lauren = upstreamRepo(root, "lauren", { "skills/a/notes.md": upstreamText, "skills/b/notes.md": "b\n" });
  const p = port(root, {
    upstream: {
      components: { pstack: { remote: lauren.dir, upstreamPath: "skills", localPath: "plugins/pstack/skills", sha: lauren.sha, exclude } },
    },
    forks: { pstack: { [path]: entry } },
    patterns: ["Task tool"],
    denylist,
    files: { "a/notes.md": "the port's own wording\n", "b/notes.md": "b\n" },
  });
  return { ...p, sha: lauren.sha };
}

describe("revert", () => {
  test("restores the upstream text with substitutions and drops the fork entry", () => {
    const { run, read, sha } = setup();
    const before = run("pstack", sha, "--dry-run");
    expect(before.stdout).toContain(`forked (upstream untouched): 1`);

    const result = run("revert", "pstack", path);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`reverted: ${path} to pstack @ ${sha.slice(0, 7)}`);
    expect(result.stdout).toContain(`removed: tools/forks.json entry for ${path}`);
    expect(read(path)).toBe("use the Agent tool\n");
    expect(JSON.parse(read("tools/forks.json"))).toEqual({ pstack: {} });
    const after = run("pstack", sha, "--dry-run");
    expect(after.status).toBe(0);
    expect(after.stdout).not.toContain("forked");
    expect(after.stderr).not.toContain("FAIL");
  });

  test.each([
    ["a path outside the component", "tools/notes.md", "is not under plugins/pstack/skills"],
    ["a path upstream lacks at the pin", "plugins/pstack/skills/c/notes.md", "upstream has no skills/c/notes.md"],
  ])("refuses %s and writes nothing", (_, target, message) => {
    const { run, read } = setup();
    const result = run("revert", "pstack", target);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(read(path)).toBe("the port's own wording\n");
    expect(JSON.parse(read("tools/forks.json")).pstack[path]).toEqual(entry);
  });

  test("refuses an excluded path", () => {
    const { run, read } = setup({ exclude: ["a/"] });
    const result = run("revert", "pstack", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is excluded in tools/upstream.json");
    expect(read(path)).toBe("the port's own wording\n");
  });

  test("refuses when the reverted text would carry a denylist hit", () => {
    const { run, read } = setup({
      upstreamText: "use the Task tool and Cursor rules\n",
      denylist: [{ token: "Cursor rules", hint: "fixture hint" }],
    });
    const result = run("revert", "pstack", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cursor-isms in the reverted text");
    expect(result.stderr).toContain(`${path}:1: "Cursor rules"`);
    expect(read(path)).toBe("the port's own wording\n");
    expect(JSON.parse(read("tools/forks.json")).pstack[path]).toEqual(entry);
  });

  test("a wrong argument count or unknown component is a usage error", () => {
    const { run } = setup();
    expect(run("revert", "pstack").status).toBe(2);
    expect(run("revert", "nope", path).status).toBe(2);
  });
});

describe("revertedForm", () => {
  test("copies a binary file byte for byte and never substitutes it", () => {
    const dir = fixtureRoot();
    const file = join(dir, "icon.png");
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x54, 0x61, 0x73, 0x6b]);
    writeFileSync(file, bytes);
    const rules = [{ match: "Task", replacement: "Agent", key: "Task" }];
    expect(revertedForm({ file, rel: "icon.png", rules })).toEqual({ bytes, mode: 0o644, hits: [] });
  });

  test("refuses to follow an upstream symlink", () => {
    const dir = fixtureRoot();
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real/x.md"), "x\n");
    symlinkSync(join(dir, "real/x.md"), join(dir, "link.md"));
    expect(() => revertedForm({ file: join(dir, "link.md"), rel: "link.md", rules: [] })).toThrow("is a symlink upstream");
    expect(readFileSync(join(dir, "real/x.md"), "utf8")).toBe("x\n");
  });
});
