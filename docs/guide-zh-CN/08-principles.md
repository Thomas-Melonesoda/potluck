# 用原则的名字来引导

[English](../guide/08-principles.md) | **中文**

<!-- translated-from: 08-principles.md sha256:11de3a3b1c4e0f4cec168b2c8431993593ec8733bf8210521958c3adc2b7cf1f -->

pstack 带有 24 条原则，每条都是一个单独的 skill。`/poteto-mode` 在每个多步骤任务开始时读取它们的索引，应用这个任务触发的那些原则，并在回复里写出每条用上的原则，以及它改变了哪个决定。

你不需要调用原则。你用它们的名字来引导。每个名字都指向一条 agent 已经读过的完整规则，所以一句话就能比一整段指示更精确地扭转工作方向。

<a id="steering-in-practice"></a>
## 实际怎么引导

假设 agent 正准备在已有的三个适配器之外再硬加一个新的：

```text
use subtract before you add. delete the obsolete adapters first, then design what's left.
```

假设它因为构建通过了就宣布成功：

```text
apply prove it works. run the real import flow and show me the written records.
```

假设两个并行的尝试马上要往同一个分支写东西：

```text
separate before serializing shared state. give each attempt its own worktree, no locks.
```

每句话之所以管用，是因为背后的规则很具体。agent 仍然必须在回复里说出这条规则改变了哪个决定。如果引用了原则，却没有对应的决定，说明 agent 只是报了规则的名字，并没有真正应用它。

<a id="the-24-briefly"></a>
## 24 条原则简介

核心原则决定做多少，以及什么时候重新考虑设计：

- [Laziness Protocol](../../plugins/pstack/skills/principle-laziness-protocol/SKILL.md)：优先删除，优先选能解决问题的最小改动。
- [Foundational Thinking](../../plugins/pstack/skills/principle-foundational-thinking/SKILL.md)：在写逻辑之前先选定核心数据结构。
- [Redesign from First Principles](../../plugins/pstack/skills/principle-redesign-from-first-principles/SKILL.md)：把新需求整合进来，就像它从第一天起就在那里。
- [Attack the Premise](../../plugins/pstack/skills/principle-attack-the-premise/SKILL.md)：把两次或更多次失败的修复共同依赖的前提写下来，在下一次修复之前直接检验它。
- [Subtract Before You Add](../../plugins/pstack/skills/principle-subtract-before-you-add/SKILL.md)：先去掉累赘，再在上面构建。
- [Minimize Reader Load](../../plugins/pstack/skills/principle-minimize-reader-load/SKILL.md)：压缩读者必须记在脑子里的层级和隐藏状态。
- [Outcome-Oriented Execution](../../plugins/pstack/skills/principle-outcome-oriented-execution/SKILL.md)：让重写直接收敛到目标设计，而不是保留一次性的兼容过渡状态。
- [Experience First](../../plugins/pstack/skills/principle-experience-first/SKILL.md)：选择用户得到的结果，而不是实现上的方便。
- [Exhaust the Design Space](../../plugins/pstack/skills/principle-exhaust-the-design-space/SKILL.md)：没有先例时，做两三个相互竞争的原型。
- [Build the Lever](../../plugins/pstack/skills/principle-build-the-lever/SKILL.md)：写出完成或证明这项工作的脚本，让审查者可以重新运行。当一个 agent 一直在手动做同一件事时，让它写出它希望自己拥有的那个工具或 skill。如果某一步能用脚本每次都一样地完成，就用脚本，把 agent 留给需要判断的事。

架构原则决定状态、校验和兼容性放在哪里：

- [Model the Domain](../../plugins/pstack/skills/principle-model-the-domain/SKILL.md)：把反复出现的规则编码进一个结构里，而不是散落在各处的条件判断里。
- [Boundary Discipline](../../plugins/pstack/skills/principle-boundary-discipline/SKILL.md)：在边界处校验，在内部信任类型。
- [Type System Discipline](../../plugins/pstack/skills/principle-type-system-discipline/SKILL.md)：让非法状态根本无法表示。
- [Make Operations Idempotent](../../plugins/pstack/skills/principle-make-operations-idempotent/SKILL.md)：让重试收敛到同一个最终状态。
- [Migrate Callers Then Delete Legacy APIs](../../plugins/pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md)：迁移和删除在同一轮里完成。
- [Separate Before Serializing Shared State](../../plugins/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md)：先消除共享，再考虑加协调。

验证原则规定什么才算证据：

- [Prove It Works](../../plugins/pstack/skills/principle-prove-it-works/SKILL.md)：验证真实的产物，而不是替代品。
- [Fix Root Causes](../../plugins/pstack/skills/principle-fix-root-causes/SKILL.md)：改代码之前，先复现问题并追到原因。
- [Sequence Work into Verifiable Units](../../plugins/pstack/skills/principle-sequence-verifiable-units/SKILL.md)：每个小单元都以一次检查收尾，再开始下一个。
- [Test Behavior, Not Implementation](../../plugins/pstack/skills/principle-test-behavior-not-implementation/SKILL.md)：断言代码的使用者能观察到的东西，这样当这个行为坏掉时测试会失败，而内部实现改动时测试仍然能通过。
- [Explain the Number](../../plugins/pstack/skills/principle-explain-the-number/SKILL.md)：在任何人相信或报告一个测量出来的数字之前，先说清是什么限制了它，并排除它其实测到了别的东西。[`/benchmark-checklist`](../../plugins/pstack/skills/benchmark-checklist/SKILL.md) 把它变成七个要用真实运行来回答的问题。

委派原则让并行的工作不至于乱套：

- [Guard the Context Window](../../plugins/pstack/skills/principle-guard-the-context-window/SKILL.md)：把大量阅读交给子 agent，只把结论留在主对话里。
- [Never Block on the Human](../../plugins/pstack/skills/principle-never-block-on-the-human/SKILL.md)：可撤销的工作直接推进，然后把结果拿给人看。

还有一条元原则：

- [Encode Lessons in Structure](../../plugins/pstack/skills/principle-encode-lessons-in-structure/SKILL.md)：把你重复说过两次的建议变成 lint、检查或脚本。[`/correct`](../../plugins/pstack/skills/correct/SKILL.md) 把它应用到整个仓库，做法见[变成你自己的](./09-make-it-yours.md#fix-the-environment-with-correct)这一页。

不用背这份清单。现在扫一遍，等你发现 agent 做了某件本可以用这里某个名字避免的事时，再回来查。词汇就是这样记住的。

下一页：[变成你自己的](./09-make-it-yours.md)。
