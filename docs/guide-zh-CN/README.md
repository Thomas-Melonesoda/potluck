# pstack 使用指南

[English](../guide/README.md) | **中文**

<!-- translated-from: README.md sha256:bab14d7ac54a5dba7a100e848b75f48c7e5e0e166ccdc6debe88089b11e213e3 -->

当你不再事事插手 agent 时，pstack 的效果最好。你说清楚想要什么，以及怎样算做完。`/poteto-mode` 会选 playbook，按步骤需要调用其它 skill，再把证据拿给你看。这份指南用贴近真实的 prompt 帮你养成这个习惯。

你会学到这些：

1. [安装 pstack](./01-setup.md)。安装插件，选好模型。
2. [通过 `/poteto-mode` 分派工作](./02-poteto-mode.md)。给它一个目标，看它选 playbook。
3. [改代码之前先理解它](./03-understand.md)。在改任何东西之前，先做一次只读调查，再用 `/how`、`/why`、`/teach` 和 `/recall`。
4. [写代码之前先做设计](./04-design.md)。在代码定型之前，先用 `/architect`、`/arena`、`/swarm`、`/interrogate`、原型和计划。
5. [构建改动，清理 diff](./05-build-and-clean.md)。实现类 playbook、`/tdd`、`/unslop` 和 `/no-comments`。
6. [验证结果并开 PR](./06-verify-and-ship.md)。在真实应用上证明行为，对测试很少覆盖到的地方做形式化验证，用 `/benchmark-checklist` 核查数字，然后开一个聚焦的 PR，一路推进到合并。
7. [睡觉时让工作继续跑](./07-overnight.md)。先建立信任再跑循环，一份过夜约定，一份你能审查的决定记录，以及能扩展到不止一个 agent 的协同计划和自动化。
8. [用原则的名字来引导](./08-principles.md)。能在任务中途让 agent 改变方向的 24 个名称。
9. [变成你自己的](./09-make-it-yours.md)。你自己的 mode，用 `/correct` 处理反复出现的错误，以及怎样测试对 skill 的改动。
10. [配方和坑](./10-recipes-and-pitfalls.md)。可以直接复制的 prompt，以及可以避开的错误。

第一次请按顺序读。之后每一页都可以单独看。

卡住了，或者分不清该用哪个 skill 时，输入 [`/poteto-help`](../../plugins/pstack/skills/poteto-help/SKILL.md) 加上你的问题：

```text
/poteto-help which skill should i use to review this branch?
```

它会回答，给你一条可以发送的 prompt，并附上答案出处的 skill 或指南页面链接。它不会直接开工，因为一次 pstack 运行会花掉真实的 token，所以等你准备好了再发送那条 prompt。只有你输入它时，它才会运行。

<a id="if-you-only-remember-one-thing"></a>

## 如果只记住一件事

用你自己的话，给 agent 一个目标和一个检查方法：

```text
/poteto-mode the export writes duplicate rows when a retry lands mid-run. repro first, then fix and verify.
```

你不需要点名 playbook，也不需要列出 skill。"repro first"（先复现）加上一个可检查的结果，就是 `/poteto-mode` 分派所需的全部信号。它会匹配到 Bug fix playbook，把步骤复制进待办清单，并在每一步触发时调用合适的 skill。

下一页：[安装 pstack](./01-setup.md)。
