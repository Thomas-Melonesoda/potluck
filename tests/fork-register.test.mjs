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
const register = { source: "michael", choice: "compromise", row: "S3-A1, S3-A11", ruling: "Owner wants no human step.", ruling_zh: "负责人不要人工步骤。", decided: "2026-11-21" };
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
    [{ row: "A1" }, 'row "A1" is not like "S3-A1" or "S3-A1, S4-G1"'],
    [{ row: "s3-a1" }, 'row "s3-a1" is not like'],
    [{ row: "S3-A1,S3-A2" }, 'row "S3-A1,S3-A2" is not like'],
    [{ ruling_zh: 3 }, "ruling_zh must be a string"],
    [{ ruling: 3 }, "ruling must be a string"],
    [{ decided: "11/21/2026" }, 'decided "11/21/2026" is not a YYYY-MM-DD date'],
  ])("a bad value fails naming the field: %o", (fields, message) => {
    expect(() => parse(fields)).toThrow(`forks.json kit "${path}": ${message}`);
  });

  test("a field outside both sets is still unknown", () => {
    expect(() => parse({ owner: "x" })).toThrow('unknown field "owner"');
  });
});

test("no ruling in potluck's tools/forks.json cites a row without its step prefix", () => {
  const registry = JSON.parse(readFileSync(join(repo, "tools/forks.json"), "utf8"));
  // A row cited in parentheses, like "(A8)", "(B3, B4)", or "(group H)", must read "(S3-A8)".
  const bare = /\((?:group )?(?:[A-HMR]\d{0,2})(?:, [A-HMR]\d{0,2})*\)/;
  const stale = Object.values(registry)
    .flatMap((entries) => Object.entries(entries))
    .filter(([, entry]) => [entry.ruling, entry.ruling_zh].some((text) => text && bare.test(text)))
    .map(([path]) => path);
  expect(stale).toEqual([]);
});

test("every entry in potluck's tools/forks.json carries the whole register", () => {
  const registry = JSON.parse(readFileSync(join(repo, "tools/forks.json"), "utf8"));
  const fields = ["source", "choice", "row", "ruling", "decided"];
  const incomplete = Object.values(registry)
    .flatMap((entries) => Object.entries(entries))
    .filter(([, entry]) => fields.some((field) => entry[field] == null || entry[field] === ""))
    .map(([path]) => path);
  expect(incomplete).toEqual([]);
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
      "| `plugins/pstack/skills/s.md` | S3-A1, S3-A11 | compromise / 折中 | policy / 政策 | Keeps a \\| out of the table. | Owner wants no human step.<br>负责人不要人工步骤。 | 2026-11-21 |",
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
