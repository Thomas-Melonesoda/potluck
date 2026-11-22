# 安装 pstack

[English](../guide/01-setup.md) | **中文**

<!-- translated-from: 01-setup.md sha256:89596bdba13417a0d0c9c2aa705170772c2aa8db3174c218f1ebe5d7daa7384b -->

这一页里，你会安装插件，选择 pstack 用哪些模型，并运行第一个任务。安装只需要一条命令加一段简短的对话。

<a id="install-the-plugin"></a>

## 安装插件

按 [README](../../README.zh-CN.md#安装) 里的步骤，为你的 agent 安装 potluck。在 Claude Code 上，插件命令带 `pstack:` 前缀，所以本指南里的每条命令在那里都写成 `/pstack:setup-pstack` 这样。Codex 用 `$<name>` 调用 skill，其它差异由 `skills/poteto-mode/references/` 下各运行环境的对照说明覆盖。

<a id="pick-your-models"></a>

## 选择模型

运行：

```text
/setup-pstack
```

[`/setup-pstack`](../../plugins/pstack/skills/setup-pstack/SKILL.md) 会检测你能用哪些模型，询问推理预算，向你展示每个角色（写代码的委派、判断、评审小组），并问你想怎么配。回答这些问题即可。它会写出 `pstack-models.md`，这是每个 pstack skill 都会读取的一条小规则。

默认值和 `large` 预算相同。代码、文字和判断都在 Opus 5.5 上以 `xhigh` 推理强度运行，评审小组和 swarm worker 以 `high` 运行。没有任何角色高于 `xhigh`。在评审小组之外，Fable 5.2 只在两种情况下运行：你为某个任务点名用它，或者同一份任务说明用 Opus 5.5 跑了两次都没通过检查。`medium` 把每个角色降一级，`small` 降两级，两者都更省 token。

你只需要改你在意的部分。规则里没有对应行的角色，沿用 skill 的默认值。要恢复默认值，删掉那个角色的那一行。重新运行 `/setup-pstack` 时，模型和默认值不同的角色都会被保留。默认值变了以后，变更之前写下的规则仍会把角色固定在旧的默认值上，直到你再次运行 `/setup-pstack`。那次运行会替换它认得的旧默认值，告诉你替换了哪些，并保留你的其它选择。要去掉它认不出来的固定值，先删掉那个角色的那一行，或者删掉整个文件。

你可能想知道用 Auto 会怎样。把某个角色设为 `inherit-parent` 或 `auto`，pstack 就会省略子 agent 的 `model` 字段，于是子 agent 继承你父级对话的模型。这两个值意思相同，都不是模型的 slug。对评审小组角色来说，值是一个列表，每个条目运行一个子 agent，所以列表长度决定小组的规模。安装过程还会配置 `swarm workers`，也就是每个 `/swarm` worker 的默认模型，除非某次比拼为每一路分别指定了模型。

<a id="accept-the-verification-offers-or-dont"></a>

## 接受或拒绝验证提议

安装结束时，`/setup-pstack` 会在你的项目里寻找证明应用行为的办法，要么是一个 `verify-*` skill，要么是现成的 harness。两者都没找到时，它会提议一次，用 [`/create-verification-skill`](../../plugins/pstack/skills/create-verification-skill/SKILL.md) 生成一个。

答应的话，它会写出 `.claude/skills/verify-<app>/`，这是一个项目本地的 skill，教 agent 像用户那样操作你的应用。交给你之前，它会先证明这个 skill 能用一次。拒绝的话，安装会继续往下走。你随时可以自己运行 `/create-verification-skill`。[验证结果并开 PR](./06-verify-and-ship.md#create-a-project-verification-skill)对此有详细介绍。

如果你刚接触 pstack，就答应。能检查自己工作的 agent 会一直做下去，直到检查通过。不能检查的 agent 会把每个结果都交还给你手动检查。在这份指南的所有内容里，验证 skill 的回报最大。

接着，安装过程会提议一次，用 [`/create-formal-verification-skill`](../../plugins/pstack/skills/create-formal-verification-skill/SKILL.md) 生成一个形式化验证 skill，除非项目里已经有了。测试只检查有人想到要写的情况。形式化验证 skill 检查代码的一个关键性质（比如"一个任务永远不会同时运行两次"），覆盖给定范围内的每一种情况。如果你的代码涉及并发、重试、状态机或解析器，也就是 bug 代价高、而测试很少碰到出错情况的地方，就答应。否则就拒绝，等情况变了再运行它。[验证结果并开 PR](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill)对此有介绍。

安装完成后，开一个新对话。模型规则对新会话生效。

<a id="keep-the-cost-in-check"></a>

## 控制成本

pstack 会在子 agent 和评审小组上多花 token。这是严谨的代价。想少花一些：

- 重新运行 `/setup-pstack`，选更小的推理预算或更便宜的模型。主对话用强模型，写代码的角色用更便宜、更快的模型，是不错的分工。
- 把某个角色设为 `auto` 或 `inherit-parent`，让它用对话本身的模型。
- 缩短评审小组的列表。每个条目运行一个子 agent。
- 把 `/poteto-mode` 留给需要严谨的工作。小而明显的改动用不着它。

<a id="run-your-first-task"></a>

## 运行第一个任务

选一件真实但不大的事，用你跟同事描述它的方式来描述：

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

留意待办清单。它的前几项是照原样复制进来的、匹配到的 playbook 的步骤；这条 prompt 匹配的是 Feature playbook。

从这里开始，你可以正常输入后续消息。在 Claude Code、Codex 和其它带会话启动 hook 的运行环境里，这个 hook 会让 agent 在整个会话中，把每个涉及多个文件的改动、每个设计选择、每个原因不明的 bug 都交给 `poteto-mode` 处理，所以这类事你不用再调用它。小而局部的改动或者一个问题会被直接处理；想让它也走 `poteto-mode`，就在消息开头写上 `/poteto-mode`。

下一页：[通过 `/poteto-mode` 分派工作](./02-poteto-mode.md)。
