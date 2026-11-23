#!/usr/bin/env node
// potluck: render tools/forks.json as the read-only, bilingual docs/decisions.md.
//
//   node tools/decisions.mjs           write docs/decisions.md
//   node tools/decisions.mjs --check   exit 1 when docs/decisions.md is stale
//
// The JSON is the source; nobody edits the Markdown by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./plugin.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "docs/decisions.md";

const SOURCES = [
  ["lauren", "Files from cursor/plugins (Lauren Tan's pstack and Cursor's kits)", "来自 cursor/plugins 的文件（Lauren Tan 的 pstack 和 Cursor 的组件）"],
  ["michael", "Files from Michael Denyer's pstack-claude", "来自 Michael Denyer 的 pstack-claude 的文件"],
  ["matt", "Files from Matt Pocock's skills", "来自 Matt Pocock 的 skills 的文件"],
  ["addy", "Files from Addy Osmani's agent-skills", "来自 Addy Osmani 的 agent-skills 的文件"],
  ["ours", "potluck's own files", "potluck 自己的文件"],
];
const CHOICES = {
  lauren: "Lauren's way / 用 Lauren 的",
  michael: "Michael's way / 用 Michael 的",
  compromise: "compromise / 折中",
};
const KINDS = {
  "port-feature": "port feature / 工具适配",
  policy: "policy / 政策",
  borrow: "borrow / 借用",
};
const MISSING = "not recorded / 未登记";

// Table cells cannot hold a raw pipe or a line break.
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

export function renderDecisions(registry) {
  const entries = Object.entries(registry).flatMap(([component, paths]) =>
    Object.entries(paths).map(([path, entry]) => ({ component, path, ...entry })),
  );
  const lines = [
    "# Decisions / 决定记录",
    "",
    "<!-- Generated from tools/forks.json by `node tools/decisions.mjs`. Do not edit by hand. -->",
    "",
    "Every place where potluck differs from an upstream, with why and who decided. Generated from [`tools/forks.json`](../tools/forks.json); edit that file, then run `node tools/decisions.mjs`.",
    "",
    "potluck 和各上游不一样的每一处，以及原因和决定。由 [`tools/forks.json`](../tools/forks.json) 生成；要改就改那个文件，再运行 `node tools/decisions.mjs`。",
    "",
    "- **Source / 来源**: the upstream a file comes from, which groups the tables below. / 文件原本来自哪个上游，下面按它分组。",
    "- **Row / 行号**: the row in the owner's design review, prefixed with its step: S3-A1 is row A1 of step 3 (rows A to H), S4-G1 is row G1 of step 4 (rows M, D, G, R, X). / 设计逐条过时的行号，前面标第几步：S3-A1 是第 3 步的 A1（A 到 H），S4-G1 是第 4 步的 G1（M、D、G、R、X）。",
    "- **Choice / 选择**: whose way potluck follows. / potluck 跟谁的做法。",
    "- **Ruling / 裁定**: the owner's ruling, paraphrased in English, with a Chinese note under it where one is recorded. / 项目负责人的裁定，英文转述；有中文说明的写在下面。",
    "",
    "A choice of Lauren's way or a compromise is a decision; the file may still hold pstack-claude's text until the stage that applies it, which [the roadmap](roadmap.md) tracks. / 选了 Lauren 的或折中，表示已经定了；在 [路线图](roadmap.md) 里对应的阶段完成前，文件内容可能还是 pstack-claude 的。",
    "",
    `${entries.length} entries / 共 ${entries.length} 条.`,
  ];
  const groups = [
    ...SOURCES.map(([key, en, zh]) => [`${en} / ${zh}`, entries.filter((e) => e.source === key)]),
    ["Not yet registered / 尚未登记", entries.filter((e) => !SOURCES.some(([key]) => key === e.source))],
  ];
  for (const [title, rows] of groups) {
    if (!rows.length) continue;
    rows.sort((a, b) => (a.row ?? "~").localeCompare(b.row ?? "~", "en", { numeric: true }) || a.path.localeCompare(b.path));
    lines.push(
      "",
      `## ${title}`,
      "",
      "| File / 文件 | Row / 行号 | Choice / 选择 | Kind / 类型 | Why / 原因 | Ruling / 裁定 | Decided / 日期 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const e of rows) {
      lines.push(
        `| \`${cell(e.path)}\` | ${cell(e.row) || MISSING} | ${CHOICES[e.choice] ?? MISSING} | ${KINDS[e.kind] ?? cell(e.kind)} | ${cell(e.why)} | ${cell(e.ruling)}${e.ruling_zh ? `<br>${cell(e.ruling_zh)}` : ""} | ${cell(e.decided) || MISSING} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function main(argv) {
  const registry = JSON.parse(readFileSync(join(repo, "tools/forks.json"), "utf8"));
  const text = renderDecisions(registry);
  const out = join(repo, OUT);
  if (argv[0] === "--check") {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {}
    if (current !== text) {
      process.stderr.write(`${OUT} is stale; run node tools/decisions.mjs and commit it\n`);
      return 1;
    }
    process.stdout.write(`ok: ${OUT} current\n`);
    return 0;
  }
  if (argv.length) {
    process.stderr.write("usage: node tools/decisions.mjs [--check]\n");
    return 2;
  }
  writeFileSync(out, text);
  process.stdout.write(`write: ${OUT}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
