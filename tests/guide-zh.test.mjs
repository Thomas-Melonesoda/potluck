// potluck: the Chinese guide (design row S3-G1, bilingual) stays a faithful,
// working copy of docs/guide. Each page in docs/guide-zh-CN/ names the hash of
// the English page it was translated from, so an upstream sync that changes an
// English page fails here until the translation is updated. The checks are
// mechanical: same pages, same code blocks, anchors that still resolve, links
// that point at files that exist, and no dash punctuation.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const en = join(root, "docs/guide");
const zh = join(root, "docs/guide-zh-CN");
const pages = readdirSync(en).filter((f) => f.endsWith(".md")).sort();
const read = (dir, page) => readFileSync(join(dir, page), "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");

const fences = (text) => text.match(/^```[^\n]*\n[\s\S]*?^```$/gm) ?? [];
const prose = (text) => text.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "").replace(/`[^`\n]*`/g, "");
// GitHub's heading anchor: lowercase, drop punctuation but hyphens, spaces to hyphens.
const slug = (heading) =>
  heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
const outsideFences = (text) => text.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");
const headings = (text) => [...outsideFences(text).matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1]));
const ids = (text) => [...text.matchAll(/^<a id="([^"]+)"><\/a>$/gm)].map((m) => m[1]);

describe("Chinese guide", () => {
  test("every English page has a Chinese page and nothing else is there", () => {
    expect(readdirSync(zh).filter((f) => f.endsWith(".md")).sort()).toEqual(pages);
  });

  test.each(pages)("%s was translated from the current English page", (page) => {
    const stamp = read(zh, page).match(/^<!-- translated-from: (\S+) sha256:([0-9a-f]{64}) -->$/m);
    expect(stamp?.[1]).toBe(page);
    const current = sha(read(en, page));
    if (stamp?.[2] !== current) {
      throw new Error(
        `docs/guide/${page} changed since it was translated. Update docs/guide-zh-CN/${page} to match (git diff the English page), then set its stamp to sha256:${current}`,
      );
    }
  });

  test.each(pages)("%s keeps the code blocks byte for byte", (page) => {
    expect(fences(read(zh, page))).toEqual(fences(read(en, page)));
  });

  test.each(pages)("%s keeps every English heading anchor", (page) => {
    expect(ids(read(zh, page))).toEqual(headings(read(en, page)));
  });

  test.each(pages)("%s links resolve", (page) => {
    const text = prose(read(zh, page));
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const file = path ? resolve(zh, path) : join(zh, page);
      expect(existsSync(file), `${page}: ${target}`).toBe(true);
      if (anchor && dirname(file) === zh && file.endsWith(".md")) {
        expect(ids(readFileSync(file, "utf8")), `${page}: ${target}`).toContain(anchor);
      }
    }
  });

  // The English page's links, as the Chinese page should carry them: images
  // from the shared folder, the README in Chinese (its anchors are Chinese).
  const targets = (text) => [...prose(text).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const asChinese = (target) =>
    target.replace(/^\.\/images\//, "../guide/images/").replace(/^\.\.\/\.\.\/README\.md(#.*)?$/, "../../README.zh-CN.md");
  test.each(pages)("%s carries every English link and no other", (page) => {
    const chinese = targets(read(zh, page)).slice(1).map((t) => t.replace(/^(\.\.\/\.\.\/README\.zh-CN\.md)#.*$/, "$1"));
    expect(chinese.sort()).toEqual(targets(read(en, page)).map(asChinese).sort());
  });

  test.each(pages)("%s puts each anchor right above its heading", (page) => {
    const lines = read(zh, page).split("\n");
    lines.forEach((line, i) => {
      if (!/^<a id="/.test(line)) return;
      const next = lines[i + 1] === "" ? lines[i + 2] : lines[i + 1];
      expect(next, `${page}:${i + 1}`).toMatch(/^#{2,3} /);
    });
  });

  test.each(pages)("%s links back to its English page and uses no dash punctuation", (page) => {
    const text = read(zh, page);
    expect(text.split("\n")[2]).toBe(`[English](../guide/${page}) | **中文**`);
    expect(prose(text)).not.toMatch(/[—–―]|\s--\s/);
  });
});
