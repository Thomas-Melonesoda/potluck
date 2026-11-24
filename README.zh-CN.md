# potluck

[English](README.md) | **中文**

potluck 是一个开源的 agent 工作系统。它想同时做到两件事：agent 自主程度拉满，系统完整度也拉满。这样即使使用者不审代码、不做架构设计（比如产品经理、设计师，或任何人），也能从 agent 那里拿到经过验证的结果。

名字取"百家饭"的意思，它来自四个开源项目：

| 来源 | potluck 从中拿什么 |
| --- | --- |
| Lauren Tan 的 [pstack](https://github.com/cursor/plugins/tree/main/pstack) | 主体：`poteto-mode`、它的 playbook、原则和验证方法。pstack 有现成做法的地方，potluck 就用它的。 |
| Michael Denyer 的 [pstack-claude](https://github.com/michael-denyer/pstack-claude) | 本仓库 fork 的基础：把 pstack 翻译到 Claude Code、Codex、Pi、GitHub Copilot、Muse 等工具上，以及他的同步工具。 |
| Matt Pocock 的 [skills](https://github.com/mattpocock/skills) | `prototype`、`wizard` 和 `domain-modeling`（术语表和决定记录的格式），从上游同步，以及 potluck `grill` 所用的提问方法。 |
| Addy Osmani 的 [agent-skills](https://github.com/addyosmani/agent-skills) | `constraint-driven-development`（`CONSTRAINTS.md` 和始终生效的质量底线），从上游同步；potluck 分层 skill eval 的思路也来自他。 |

potluck 和各上游不一样的每一处，都登记在 [`tools/forks.json`](tools/forks.json) 里。

> **现状：施工中。** 目前本仓库的内容和 Michael Denyer 的 pstack-claude v0.9.146 一致，只改了对外名称。插件安装后的内部 ID 仍是 `pstack`，各个 skill 也保留上游的名字（比如 `poteto-mode`），这样跟进上游更新的成本最低。阶段 3 的政策调整已经加进来，阶段 4 正在加借用的 skill，进度见[路线图](docs/roadmap.md)。

把目标告诉 `poteto-mode`，它会为这个任务选对工作流程，让代码保持简洁、简单、经过验证。

## 安装

下面只列 Claude Code 和 Codex。其它工具（Pi、GitHub Copilot、Muse、OMP、Kimi Code CLI、Grok Build、MiniMax Code、OpenCode 2、Antigravity 等）的安装方法见[英文 README](README.md#install)。

### Claude Code

在 Claude Code 2.1.292 或更新版本里运行：

```text
/plugin marketplace add Thomas-Melonesoda/potluck
/plugin install pstack@potluck
```

Claude Code 默认不给第三方 marketplace 开自动更新。要开的话，运行 `/plugin`，打开 **Marketplaces** 标签，选 `potluck`，再选 **Enable auto-update**。想手动更新一次，运行 `claude plugin update pstack@potluck`。

### Codex

在终端里运行：

```shell
codex plugin marketplace add Thomas-Melonesoda/potluck
codex plugin add pstack@potluck
```

输入 `$` 加 skill 名（比如 `$poteto-mode`）来调用，`/skills` 会列出所有 skill。

## git 护栏

在 Claude Code 里，agent 每次执行 shell 命令前，potluck 会先检查一下。仓库里有未提交的改动、未跟踪的文件，或者只有这里才有的提交时，它会拦住会弄丢这些东西的 git 命令：`reset --hard`、`clean -f`、会丢掉改动的 `checkout`、`switch` 或 `restore`、不带 `--force-with-lease` 的强推，以及删除一个提交只在它上面的分支。报错会告诉 agent 先怎么保存，所以它不用等你就能接着做。有三条 push 规则在仓库干净时也照样生效，因为共享分支上有别人的工作：不许 push 到默认分支（远程的默认分支、`main` 或 `master`），普通 push、强推、带 lease 都不行，改动要走 pull request；同一条命令里先 `checkout` 或 `switch` 再 push 时，push 必须写明推到哪个分支（`git push -u origin <分支>`），因为检查在切换分支之前就跑了，写不明的就分成两条命令执行；不许删除远程分支（`git push origin :<分支>`、`--delete`、`--prune`、`--mirror`）。其他推到别的分支的 push 都放行。检查只读命令行，所以脚本文件、git 别名、运行时才拼出来的命令拦不住。这项检查需要电脑上有 `node`；没有的话，命令照常执行。

## 开始使用

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

遇到 bug 时，它会先复现失败，用 `how` 和 `why` 查原因，把修复交给子 agent，再重跑失败的用例。你拿到的是修复本身，以及修复前失败、修复后通过的证据。

Lauren Tan 写的使用指南见 [中文版](docs/guide-zh-CN/README.md)（[英文原版](docs/guide/README.md)）。项目需要哪些文档、各由谁写、哪些自动生成，见[项目文档指南](docs/project-docs.zh-CN.md)。更多细节（skill 和命令列表、各工具的设置、模型配置）见 [docs/reference.md](docs/reference.md)（英文）。

## 数据

potluck 没有服务器，也没有遥测。skill 让 agent 读的任何内容（包括会话记录）都会发给你用的模型服务商。脚本都在本地运行，PR 相关工具用的是你自己的 GitHub CLI 登录。

## 参与

欢迎提 bug、改文档、改进各工具的适配。检查方法和改动该放哪里见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

属于上游的问题，最好直接报给上游：工具适配问题报给 [pstack-claude](https://github.com/michael-denyer/pstack-claude)，skill 内容问题报给 [cursor/plugins](https://github.com/cursor/plugins)。

## 致谢

potluck 建立在 Lauren Tan（pstack 和 poteto-mode）、Michael Denyer（多工具移植和同步工具）、Matt Pocock 和 Addy Osmani 的工作之上。谢谢他们。

## 许可证

potluck 使用 [MIT 许可证](LICENSE)。原版 pstack © 2026 Lauren Tan；pstack-claude 移植的修改和新增 © 2026 Michael Denyer；potluck 的修改和新增 © 2026 Thomas-Melonesoda；来自 cursor-team-kit 和 thermos 的 skill © 2026 Cursor。详见 [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit)、[LICENSE-thermos](LICENSE-thermos) 和 [NOTICE.md](NOTICE.md)。
