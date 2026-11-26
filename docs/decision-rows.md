# Rows outside the fork register / 不在登记表里的行号

[`decisions.md`](decisions.md) is generated from [`tools/forks.json`](../tools/forks.json), which holds only upstream files whose text potluck or pstack-claude changed. The sync fails on an entry for any other path. So a file this repository wrote itself, or took from an upstream with only the declared substitutions, has no entry there. This page, kept by hand, says which rows those files carry and where each is checked. A row that is in `decisions.md` as well says so.

[`decisions.md`](decisions.md) 由 [`tools/forks.json`](../tools/forks.json) 生成，那里只登记正文被 potluck 或 pstack-claude 改过的上游文件，登记别的路径会让同步检查失败。所以本仓库自己写的文件，以及只套了翻译规则、正文没改的上游文件，在那里没有登记。这一页手工维护，写明这些文件对应哪些行号、在哪里检查。同时也在 `decisions.md` 里的行号会注明。

In the tables, `hooks/` and `skills/` are under `plugins/pstack/`, and `scripts/` is `skills/poteto-mode/scripts/`. / 表里的 `hooks/`、`skills/` 都在 `plugins/pstack/` 下，`scripts/` 指 `skills/poteto-mode/scripts/`。

## Step 3 / 第 3 步

| Row / 行号 | What / 内容 | Files / 文件 | Checked by, PR / 检查和 PR |
| --- | --- | --- | --- |
| S3-A8 | Merging: a verdict status, green CI, `gh pr merge --match-head-commit`; the merge gate script was retired on 2026-11-25 / 合并：verdict 状态、CI 通过、`gh pr merge --match-head-commit`；合并门脚本 2026-11-25 停用 | the Shipping and Autopilot-full playbooks (in `decisions.md`), `.github/workflows/ci.yml` (the floor job) | `tests/potluck-rules.test.mjs`, `tests/floor.test.mjs`; #8, #9, #19 |
| S3-C3 | Worktree backup and removal / worktree 备份和移除 | `scripts/worktree-backup.mjs`, `scripts/worktree-remove.mjs` (the playbook is in `decisions.md`) | `tests/worktree-backup.test.mjs`, `tests/worktree-remove.test.mjs`; #10, #38, #42 |
| S3-A6 | The limit of two fix rounds per PR, recorded by a script / 每个 PR 最多两轮修复，由脚本记录 | `scripts/fix-rounds.mjs`, potluck's own (the playbook, `autopilot-full`, is in `decisions.md`) | `tests/fix-rounds.test.mjs`, `tests/potluck-rules.test.mjs`; #58 |
| S3-D1 | Checkpoints in a fixed form. Stage 5 issue 11 changed the script: one pointer per folder and task, folders outside Git, and HEAD recorded at each pause / 固定格式的检查点。阶段 5 第 11 条改了脚本：每个文件夹加任务一个指针，支持 Git 之外的文件夹，每次暂停记录 HEAD | `scripts/resume.mjs`, `skills/poteto-mode/references/resume-storage.md` (Michael's; Pause safely is in `decisions.md`) | `tests/resume.test.mjs`; #35, #40 |
| S3-E4 | Principles are `user-invocable: false` / 原则用 `user-invocable: false` | The [24 leaves](#s3-e4-the-24-principle-leaves--24-个原则文件), changed by `portFrontmatter` in `tools/generate.mjs` | `tools/generate.mjs --check` fails a leaf without it; it came with pstack-claude |
| S3-E12 | The session-start routing hook, on by default, can be turned off / 开局分流钩子，默认开启，可以关掉 | See [below](#s3-e12-the-session-start-hook--开局钩子) (the switch, `setup-pstack`, is in `decisions.md`) | `tests/session-hook.test.mjs`, `tests/session-hook-windows.test.mjs`, `tests/potluck-rules.test.mjs`; the hook came with pstack-claude, #40 changed six of its texts |
| S3-G1 | Lauren's guide, in English and Chinese / Lauren 的使用指南，中英双语 | `docs/guide/` (synced component `guide` in `tools/upstream.json`, no file forked), `docs/guide-zh-CN/` (potluck's translation). For it `tools/substitutions.json` gained 17 rules, each with a rationale that starts `potluck guide:`, and 2 denylist entries (`Custom Mode`, cloud agents) / 为它加了 17 条翻译规则和 2 条禁用词 | `bun tools/sync.mjs --check-rules`, `tests/guide-zh.test.mjs`; #12, #13 |
| S3-G2, S3-G3 | `automations/` and `make-bot-ui` stay out / 不搬进来 | `exclude` of `pstack` in `tools/upstream.json` | The sync |

### S3-E4: the 24 principle leaves / 24 个原则文件

Every `skills/principle-*/SKILL.md`. At the pinned commit, Lauren's text sets `disable-model-invocation: true` on all 24, and the port's generator replaces that line. The sync derives upstream's text the same way, so the change alone is not a fork. Three leaves are forked for another row and name S3-E4 in `decisions.md`: `build-the-lever` (S3-B5), `prove-it-works` (S3-B1), and `test-behavior-not-implementation` (S3-B6). The other 21 have no entry:

每个 `skills/principle-*/SKILL.md`。在固定的上游提交里，Lauren 的 24 个原则文件都写着 `disable-model-invocation: true`，由移植的生成脚本替换。同步时上游文本也做同样的替换，所以只改这一处不算分叉。有三个文件因为别的行号登记过，已在 `decisions.md` 里补上 S3-E4（见上一段）。其余 21 个没有登记：

`attack-the-premise`, `boundary-discipline`, `encode-lessons-in-structure`, `exhaust-the-design-space`, `experience-first`, `explain-the-number`, `fix-root-causes`, `foundational-thinking`, `guard-the-context-window`, `laziness-protocol`, `make-operations-idempotent`, `migrate-callers-then-delete-legacy-apis`, `minimize-reader-load`, `model-the-domain`, `never-block-on-the-human`, `outcome-oriented-execution`, `redesign-from-first-principles`, `separate-before-serializing-shared-state`, `sequence-verifiable-units`, `subtract-before-you-add`, `type-system-discipline`.

### S3-E12: the session-start hook / 开局钩子

Michael's files. potluck changed the six texts marked (#40) in that PR, to route handoff requests in any language (stage 5 issue 11). / 都是 Michael 的文件。标了 (#40) 的六份文本由 potluck 在这个 PR 里改过，让任何语言的交接请求都能分流（阶段 5 第 11 条）。

- Scripts / 脚本: `hooks/session-start.sh`, `hooks/session-start.ps1`, and the awk files the shell script runs, `hooks/agy-context.awk`, `copilot-context.awk`, `muse-context.awk`, and `json.awk`.
- Texts / 文本: `hooks/session-start-context.md` (#40), `session-start-agy.md` (#40), `session-start-minimax.md` (#40), `session-start-muse.md` (#40), `session-start-opencode.md` (#40), `kimi-instructions.md` (#40), `session-start-muse-sheet.md`, `session-start-copilot.md`, `session-start-copilot-sheet.md`, `session-start-copilot-setup.md`.
- Where each runtime registers it / 各工具在哪里注册: `hooks/hooks.json` (Claude Code, MiniMax Code), `hooks/codex-hooks.json`, `hooks/copilot-hooks.json`, `plugins/pstack/hooks.json` (Antigravity), `.muse-plugin/plugin.json`, `kimi.plugin.json` at the root, `pi/prompt.ts`, `omp/index.mjs`, `opencode/index.js`.
- Turned off with / 关掉的办法: `session hook: off` in the sheet (`setup-pstack`), or `PSTACK_SESSION_HOOK=off`. [Automatic routing](reference.md#automatic-routing) says which runtimes read which. / 各工具认哪一种，见这一节。

## Step 4 / 第 4 步

| Row / 行号 | What / 内容 | Files / 文件 | Checked by, PR / 检查和 PR |
| --- | --- | --- | --- |
| S4-G1 to S4-G8 | `grill` | `skills/grill/SKILL.md`, potluck's own (the route to it, S4-G1 and S4-G8, is in `decisions.md`) | `tests/potluck-rules.test.mjs`; #20 |
| S4-R1 | Sources in fixed places / 底层来源放在固定位置 | `skills/grill/SKILL.md` | `tests/potluck-rules.test.mjs`; #20 |
| S4-R2, S4-R4 | Generated overview and staleness check / 生成的总览和脱节检查 | `skills/grill/scripts/overview.mjs`, run by `scripts/floor.mjs`; potluck's own. Since 2026-11-25 the check runs in CI's floor job (S4-R2 is in `decisions.md` as well) / 2026-11-25 起脱节检查在 CI 的底线任务里 | `tests/overview.test.mjs`, `tests/floor.test.mjs`; #23, #25 |
| S4-R6 | Project documents guide / 项目文档指南 | `docs/project-docs.md`, `docs/project-docs.zh-CN.md`, potluck's own; its questions in `skills/grill/SKILL.md` | `tests/potluck-rules.test.mjs`; #24 |
| S4-M3 | Glossary format / 术语表格式 | `skills/domain-modeling/GLOSSARY-FORMAT.md`, synced from Matt Pocock (the skill's description, a borrow, is in `decisions.md`) | The sync; #17 |
| S4-M4 | Decision record (ADR) format / 决定记录格式 | `skills/domain-modeling/ADR-FORMAT.md`, synced | The sync; #17 |
| S4-M7 | `prototype` | `skills/prototype/`, synced | The sync; #17 |
| S4-M10 | `wizard` | `skills/wizard/`, synced | The sync; #17 |
| S4-M11 | Git guardrail / git 护栏 | `hooks/git-guardrail.mjs`, `hooks/git-guardrail.sh`, potluck's own, registered in `hooks/hooks.json` and `hooks/codex-hooks.json` | `tests/git-guardrail.test.mjs`; #16, #33, #41, #44, #45, #54 |
| S4-D4 | `CONSTRAINTS.md` template / `CONSTRAINTS.md` 模板 | `skills/constraint-driven-development/SKILL.md` (step 3 holds the template) and its `scripts/quality-gate.mjs`, synced from Addy Osmani | The sync; #18 |
| S4-D5 | The floor / 底线 | `references/floor-guard.md` of the same skill, a borrow in `decisions.md`, run by `scripts/floor.mjs` in CI | `tests/floor.test.mjs`; #18, #19, #29, #36, #43 |
| S4-D7 | No rationalization table / 不要反借口表 | A rule in `tools/substitutions.json` drops it from `constraint-driven-development` | `bun tools/sync.mjs --check-rules`; #18 |
| S4-D8 | Three eval layers / 三层 eval | Layers 1 and 2: `tools/eval.mjs`, `evals/triggers.json`, a step in `.github/workflows/ci.yml`. Layer 3: `plugins/pstack/evals/`, run on request. potluck's own (one description it led to is in `decisions.md`) | `tests/eval.test.mjs`; #15, #21, #22, #32 |

Each synced component has its pin in `tools/upstream.json` and its rules, with a rationale each, in `tools/substitutions.json`. / 每个同步组件的固定版本在 `tools/upstream.json`，翻译规则和理由在 `tools/substitutions.json`。

## Stage 5 files with no row / 阶段 5 新增、没有行号的文件

These come from the stage 5 answers, which number issues, not rows. [The roadmap](roadmap.md) describes each. / 来自阶段 5 的答复，只有条号，没有行号，内容见[路线图](roadmap.md)。

- `scripts/gates.mjs`, `hooks/operator-gates.mjs`, `hooks/gates-lock.sh`: the operator's gates / 操作者的门 (#39, #44, #54).
- `skills/grill/scripts/starter.mjs`, `skills/grill/starter/`: the new-project starter, issue 10 / 新项目起步文件，第 10 条 (#34, #47).
