// potluck: rules written for one borrowed skill must not reach another
// component's SKILL.md. A rule's `files` pattern is matched against the path
// relative to its component, so `^SKILL\.md$` matches the root SKILL.md of
// every single-skill component (prototype, wizard, domain-modeling, and the
// constraint skill). Each such rule must anchor on text only its own skill has.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applySubstitutions, parseSubstitutions } from "../tools/sync.mjs";

const RULES = parseSubstitutions(JSON.parse(readFileSync(join(import.meta.dir, "../tools/substitutions.json"), "utf8")));

test("a single-skill component's own See Also and Common Rationalizations sections are left alone", () => {
  const other = [
    "---",
    "name: some-skill",
    "description: Something else.",
    "---",
    "",
    "## Common Rationalizations",
    "",
    "| Thought | Answer |",
    "|---|---|",
    "| skip it | do not |",
    "",
    "## Red Flags",
    "",
    "- one",
    "",
    "## See Also",
    "",
    "- `another-skill` — related",
    "",
  ].join("\n");
  expect(applySubstitutions(other, RULES.substitutions, "SKILL.md").text).toBe(other);
});
