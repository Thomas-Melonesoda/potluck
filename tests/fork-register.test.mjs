// potluck: the decision register on tools/forks.json entries, and the
// generated docs/decisions.md that renders it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderDecisions } from "../tools/decisions.mjs";
import { parseForks } from "../tools/sync.mjs";

const repo = join(import.meta.dir, "..");
const components = { kit: { localPath: "plugins/pstack/skills" } };
const path = "plugins/pstack/skills/s.md";
const base = { kind: "policy", why: "Fixture fork.", since: "0.9.48", upstream: "not-proposed" };
const register = { source: "michael", choice: "compromise", row: "A1, A11", ruling: "Owner wants no human step.", decided: "2026-11-21" };
const parse = (fields) => parseForks({ kit: { [path]: { ...base, ...fields } } }, components);

describe("register fields in parseForks", () => {
  test("an entry with every register field parses, and one with none still parses", () => {
    expect(parse(register).kit.get("s.md")).toEqual({ ...base, ...register });
    expect(parse({}).kit.get("s.md")).toEqual(base);
  });

  test("borrow is a kind", () => {
    expect(parse({ kind: "borrow" }).kit.get("s.md").kind).toBe("borrow");
  });

  test.each([
    [{ source: "cursor" }, 'source "cursor" is not one of lauren, michael, matt, addy, ours'],
    [{ choice: "theirs" }, 'choice "theirs" is not one of lauren, michael, compromise'],
    [{ row: "a1" }, 'row "a1" is not like "A1" or "A1, A11"'],
    [{ row: "A1,A2" }, 'row "A1,A2" is not like'],
    [{ ruling: 3 }, "ruling must be a string"],
    [{ decided: "11/21/2026" }, 'decided "11/21/2026" is not a YYYY-MM-DD date'],
  ])("a bad value fails naming the field: %o", (fields, message) => {
    expect(() => parse(fields)).toThrow(`forks.json kit "${path}": ${message}`);
  });

  test("a field outside both sets is still unknown", () => {
    expect(() => parse({ owner: "x" })).toThrow('unknown field "owner"');
  });
});

describe("renderDecisions", () => {
  test("groups by source, labels both languages, and escapes table pipes", () => {
    const text = renderDecisions({
      kit: {
        [path]: { ...base, ...register, why: "Keeps a | out of the table." },
        "plugins/pstack/skills/t.md": base,
      },
    });
    expect(text).toContain("## Files from Michael Denyer's pstack-claude / 来自 Michael Denyer 的 pstack-claude 的文件");
    expect(text).toContain(
      "| `plugins/pstack/skills/s.md` | A1, A11 | compromise / 折中 | policy / 政策 | Keeps a \\| out of the table. | Owner wants no human step. | 2026-11-21 |",
    );
    expect(text).toContain("## Not yet registered / 尚未登记");
    expect(text).toContain("| `plugins/pstack/skills/t.md` | not recorded / 未登记 |");
    expect(text).toContain("2 entries / 共 2 条.");
  });

  test("the committed docs/decisions.md matches tools/forks.json", () => {
    const result = spawnSync("node", [join(repo, "tools/decisions.mjs"), "--check"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const registry = JSON.parse(readFileSync(join(repo, "tools/forks.json"), "utf8"));
    expect(readFileSync(join(repo, "docs/decisions.md"), "utf8")).toBe(renderDecisions(registry));
  });
});
