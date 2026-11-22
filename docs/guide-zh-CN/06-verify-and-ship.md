# 验证结果并开 PR

[English](../guide/06-verify-and-ship.md) | **中文**

<!-- translated-from: 06-verify-and-ship.md sha256:f88d3dbd06f88b2814f6b9d661ac43d01eb5959bc41deb9f5a351b6685e78066 -->

“能编译”不是证据。[Prove It Works 原则](../../plugins/pstack/skills/principle-prove-it-works/SKILL.md)要求 agent 在报告成功之前检查真实的产物，而你的任务是让“真实的产物”可以被检查。这一页讲：说明完成条件，审查测量得到的数字，为你的应用生成验证 skill，对测试很少覆盖到的性质做形式化验证，开 PR，以及把 PR 推进到合并。

在大多数 agent 工作里，验证是最慢的一步，因为这一步通常要等人。让 agent 自己能做验证，你就不再是瓶颈。跳过它，跑更多的 agent 只会给你带来更多未经检查、等着你审的工作。

![一架原型飞机在真实的测试航线上飞行，她拿着秒表计时，机器人在拍摄并按清单核对这次飞行；终端上显示 verify: pass, evidence: captured。](../guide/images/verification.jpg)

<a id="state-the-finish-condition-up-front"></a>
## 一开始就说明完成条件

在第一个 prompt 里写明怎样算完成，用什么措辞都行：

```text
/poteto-mode add json output to this command. text output stays byte-identical, the json parses, both run against the sample project. show me the evidence.
```

现在 agent 有了三项可以运行的检查，而不是一种需要迎合的感觉。回复回来时，应该带上确切的命令和输出。如果某项检查没能运行，好的回复会说“无法判定”（inconclusive）。没有证据却很自信的回复是一个警告信号。

让检查和改动对得上：

- CLI 的改动，运行真实的命令。
- UI 的改动，在运行中的应用里走一遍改过的流程。如果必须和参考图逐像素一致，[Visual parity playbook](../../plugins/pstack/skills/poteto-mode/playbooks/visual-parity.md) 会把截图和冻结的基准图做对比，而不是靠眼睛判断。
- 解析器或迁移，重放一份保存下来的输入。
- 性能改动，对比前后的性能分析结果。
- 存储改动，把写入的值读回来。

要求把证明作为你能自己检查的产物交给你：先失败后通过的测试、前后对比的视频、trace、截图。如果修复已经合并，要求在 main 上再做一次同样的检查。产物胜过听起来合理的解释，因为你不用重放整个过程就能质疑它。

对于一个你不太信任的小 diff，[`/blast-radius`](../../plugins/pstack/skills/blast-radius/SKILL.md) 会找出它可能在别处弄坏什么。它找出让这次改动安全的那一个事实，并通过运行代码来证明这个事实，而不是靠论证。

<a id="vet-a-measured-number-with-benchmark-checklist"></a>
## 用 `/benchmark-checklist` 审查测量得到的数字

前后对比的数字，是最容易在无意中弄错的证据。缓存是热的、一边用的是 debug 构建，或者工作根本没有在计时区间内运行，每一种都能制造出令人信服的提速。在报告一个数字或根据它采取行动之前，输入：

```text
/benchmark-checklist vet the export speedup before it goes in the pr
```

[`/benchmark-checklist`](../../plugins/pstack/skills/benchmark-checklist/SKILL.md) 会问七个问题，每个问题都要一次实际运行的证据：

1. 是什么限制了这个数字，为什么它不是现在的两倍？
2. 每一边都按生产环境的方式调优运行了吗？
3. 结果是否突破了物理极限，比如磁盘带宽或核心数？
4. 有没有出错或返回错误的输出？
5. 交替运行多次能否复现，有没有中位数和范围？
6. 从端到端看，在用户等待的路径上，它重要吗？
7. 工作真的发生在计时区间内吗？

结论会是更快、更慢、没有可测量的差异，或者无法判定，并附上运行次数、范围和限制因素。当它说不出限制因素，或者某一边没有调优运行时，结论就是无法判定。`/poteto-mode` 已经在 Perf issue 和 Hillclimb playbook 里运行这份清单，所以只有当你在它们之外测量了什么，或者别人的数字好得令人怀疑时，才需要自己输入。它是 [Explain the Number 原则](../../plugins/pstack/skills/principle-explain-the-number/SKILL.md)的可操作形式。

<a id="create-a-project-verification-skill"></a>
## 创建项目的验证 skill

上面关于 UI 的那一条，背后藏着一个实际要求：agent 需要一种用脚本操作你的应用的方式。如果你的项目已经有了，很好。如果没有，运行：

```text
/create-verification-skill
```

[`/create-verification-skill`](../../plugins/pstack/skills/create-verification-skill/SKILL.md) 询问的是仓库，不是你。它弄清楚用户会接触到什么、应用在本地怎么启动、用什么来操作它（优先用已有的 harness，否则用浏览器和 CDP、PTY，或者普通 HTTP）、什么证据能证明行为，以及能不能同时跑两个实例。只有代码回答不了的问题，它才来问你。

它会写出 `.claude/skills/verify-<app>/`，这是给 agent 看的说明，包含明确的 Launch、Doctor、Drive、Evidence 和 Cleanup 几节，如果附带了脚本，还有一节 Helpers；另外在 `features/` 下有一份功能地图，索引应用能做什么，以及什么结果能证明每个功能正常。这个 skill 附带一个[功能地图的完整示例](../../plugins/pstack/skills/create-verification-skill/references/feature-map-example/)，包含一个 README 索引，每个功能一个文件，都使用规定的四个 H2 标题。在交付之前，生成器会把这个 skill 从头到尾验证一次：启动、doctor 检查、操作一个功能、采集证据、清理，然后确认证据在清理之后仍然保留。如果这次验证失败，不要使用它的输出。

从此以后，“在应用里验证一下”就成了任何 agent 都能执行的一步，在这个仓库里，不需要任何关于环境搭建的对话。当你想要特定形式的证明时，在 prompt 里点名：

```text
/poteto-mode build the bulk-archive action. use /verify-<app> to verify your changes and show me a video and screenshots as proof.
```

```text
/poteto-mode repro this with /verify-<app>. if it repros on main, fix it and show me a video as proof.
```

验证 skill 能用之后，[`/swarm`](../../plugins/pstack/skills/swarm/SKILL.md) 可以按功能地图的条目把一次完整检查拆开，再汇总结果。一群验证者还可以在足够大的样本上确认一次性能提升，或者在 PR 发布前对应用做模糊测试，寻找回归。

把验证 skill 当作基础设施，而不是一次性的东西。把它提交进仓库，让团队里每个人、每个 agent 都用同样的方式操作应用。然后[打造杠杆](../../plugins/pstack/skills/principle-build-the-lever/SKILL.md)。当 agent 不断写一次性脚本去点击应用时，要求做一个小的控制 CLI，让 skill 改为调用它。agent 消耗的 token 更少，每次运行也都能重复。agent 用得好的 CLI 有这些特点：

- 少量可以组合的命令，每个都做实际的工作，而不是很多薄薄的命令。
- 任何破坏性操作都有 `--dry-run` 选项。
- 用子命令逐步展示功能，而不是一下子全部摆出来。
- 错误信息说明应该改做什么。
- 内容充实的 `--help` 文字。
- 机器可读的输出，比如 JSON。

顺便把开发环境的搭建也做成可重复的：预置数据、测试用户，以及一条每次都以同样方式启动环境的命令。

<a id="keep-the-verification-skill-honest"></a>
## 让验证 skill 保持准确

应用会变，功能地图会过时。至少每天运行一次，最好用定时自动化来跑，这样没人需要记着：

```text
/maintain-verification-skill
```

[`/maintain-verification-skill`](../../plugins/pstack/skills/maintain-verification-skill/SKILL.md) 会审查生成的 skill：先为每个功能并行安排一个只读的源码阅读者，然后做一次实际运行，操作地图上的每个功能。它的结果只会是三种之一。`clean` 表示完全覆盖，没有需要提交的东西。`changed` 表示一个包含已证实修正的 PR，改动只限于验证 skill 自己的目录。`blocked` 会说出阻碍是什么。它从不修改产品代码。如果实际运行发现了产品的回归，它会报告这个回归，而不是改一下文档把它掩盖掉。

<a id="prove-a-property-with-a-formal-verification-skill"></a>
## 用形式化验证 skill 证明一个性质

验证 skill 证明的是你实际操作过的路径。有些 bug 藏在没人操作过的路径上：两次重叠的重试、写到一半过期的锁、顺序错乱到达的状态变化。测试很少能覆盖到这些情况。对于这类 bug 代价很高的代码，运行：

```text
/create-formal-verification-skill
```

[`/create-formal-verification-skill`](../../plugins/pstack/skills/create-formal-verification-skill/SKILL.md) 从代码中挑选目标：代码做出的某个承诺，一旦被打破会伤害用户，而测试又很少能覆盖到打破它的情况。它挑的是分量最重的目标，而不是最容易验证的。如果想从某个区域或某个 bug 开始，点名即可：

```text
/create-formal-verification-skill the job lease and retry logic. a job must never run twice at once.
```

问题决定工具。事件会不会以糟糕的顺序发生，适合用模型检查器检查设计的一个小模型，不管什么语言，默认都用 TLA+。代码是否对每个输入都表现正确，适合用直接在代码上运行的验证器。如果没有能在你的语言上运行的验证器，agent 会直说，并用生成的输入测试真实代码，而不是测试一个手写的函数模型。一个在任何规模下都必须成立的性质，可能需要证明。agent 会告诉你它选了哪个工具以及原因。

它只验证一个性质，并且会展示这个性质在一个故意改坏的代码版本上失败，因为一个你从没见过失败的检查什么也证明不了。如果当前代码已经违反了这个性质，你会拿到一个反例：用你代码里的概念描述的一小串步骤。性质保持原样不变，所以这个发现始终是一个发现。除非你要求，产品代码不会改动。

它会写一个项目内的 skill，告诉下一个 agent：某次改动是否涉及被验证的代码，怎样用一条命令运行检查，以及怎样区分真正的 bug 和建模错误。在交付之前，生成器会按这个 skill 在一个故意违反该性质的临时改动上走一遍，检查必须能抓住它。交接内容会说明验证了什么、用了哪个工具和什么边界、检查发现了什么，以及它没有覆盖什么。通过只代表模型或边界内成立，不代表整个系统成立。

这个 skill 还会记录每项检查覆盖哪些代码，以及检查最后一次和代码对得上的那个提交。绕过这个 skill 的合并和重构，可能让检查继续通过，但检查的却是一段已经不存在的代码的描述。在这种情况之后，运行 [`/maintain-formal-verification-skill`](../../plugins/pstack/skills/maintain-formal-verification-skill/SKILL.md)。它会根据代码更新验证内容，重新运行，证明每项更新后的检查仍然可能失败，并告诉你每个失败是验证本身的漂移，还是代码里的 bug。

<a id="show-the-behavior-as-a-statechart"></a>
## 用状态图展示行为

用模型术语描述的反例能说服你。负责这个行为的产品经理或设计师，需要用他们的语言看到它。运行：

```text
/statechart what the user sees when they edit a note offline
```

[`/statechart`](../../plugins/pstack/skills/statechart/SKILL.md) 画出一张描述用户所见内容的 Mermaid 状态图，它由 TLA+ 模型生成，所以图和经过检查的模型不会彼此脱节。读者的规则（“离线时你永远不会看到 Synced”）会变成不变式。图上会标出每个违反规则的状态，报告会用读者的语言给出到达它的最短路径。在交付之前，agent 会在真实代码里复现每条 bug 路径，这样建模错误就不会被当成 bug 交给读者。

<a id="open-the-pr"></a>
## 开 PR

```text
/poteto-mode open the pr. small ordered commits, evidence in the description.
```

[Opening a PR playbook](../../plugins/pstack/skills/poteto-mode/playbooks/opening-a-pr.md) 在 worktree 里工作，把工作 rebase 成一个个可以独立合入的小提交，清理 diff，写一份一分钟能读完的简报作为正文，然后开出一个就绪状态的 PR。叠起来的后续 PR 胜过一个越来越大的分支。

<a id="drive-the-pr-to-merge-ready-with-babysit"></a>
## 用 Babysit 把 PR 推进到可以合并

PR 一开出来，就开始积累阻碍。检查失败，审查者留评论，主干往前走。把这些反复的琐事交给 [Babysit playbook](../../plugins/pstack/skills/poteto-mode/playbooks/babysit.md)：

```text
/poteto-mode babysit this pr. get it green.
```

Babysit 盯着 PR（在 GitHub 上用自带的监视器，有 Origin CLI 时用它），并按顺序处理阻碍：先是冲突，然后是审查讨论，最后是 CI。它从不 rebase，也从不强推。冲突或过时的基础分支会交回给你，并告诉你哪个分支需要 rebase。处理评论时它持怀疑态度，因为人和机器人会把真正的问题和噪音写在同一份列表里。真正的发现会得到修复，噪音会被驳回，并在讨论里贴出反驳的证据。如果你只想知道状态，就问得小一点，Babysit 会直接回答，不启动循环：

```text
/poteto-mode check on pr 123. anything outstanding?
```

Babysit 在“可以合并”时停下。即使一切都是绿的，它也从不合并，因为合并是另一个决定。

<a id="land-the-stack-with-shipping"></a>
## 用 Shipping 合入整叠 PR

绿不等于安全。准备合入时，直接说：

```text
/poteto-mode land the stack.
```

[Shipping playbook](../../plugins/pstack/skills/poteto-mode/playbooks/shipping.md) 在启用任何合并之前，先逐个独立验证每个 PR。每个 PR 由一个全新的 agent 实际运行来证明行为，评判改动的 agent 永远不是写它的那个。然后 Shipping 只合入从底部开始、连续通过验证的那一段，一次一个 PR，默认通过 GitHub，有 Origin CLI 时通过 Origin，并报告第一个打断这条链的 PR。一个已验证的 PR 如果压在一个未验证的 PR 上面，就要等着，因为合并它会把那个缺口一起带进去。

下一页：[睡觉时让工作继续跑](./07-overnight.md)。
