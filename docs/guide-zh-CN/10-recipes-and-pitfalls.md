# 配方和坑

[English](../guide/10-recipes-and-pitfalls.md) | **中文**

<!-- translated-from: 10-recipes-and-pitfalls.md sha256:1edded9027582b2e487e02262db1692019995f997149eacb4a0aed7598514c1c -->

先是值得照抄的 prompt，然后是每个人都会犯一次的错误。把里面的路径和完成条件换成你自己的。这些配方是故意写得很随意的。实际敲 prompt 时就是这样写的，skill 也能很好地读懂意图。

![她在尝一道做好的菜，机器人们照着一个菜谱盒做饭，灶台上方钉着写有 /how、/tdd 和 /loop 的卡片。](../guide/images/recipes.jpg)

<a id="understand-an-unfamiliar-subsystem"></a>
## 弄懂一个陌生的子系统

```text
use /how first to understand how this initialization works. then use /why to figure out why it broke recently.
```

先看机制，再看历史。每个 skill 的报告都会告诉你它搜索了哪些来源，所以你知道答案的依据是什么。

<a id="restate-a-noisy-report-before-touching-code"></a>
## 动代码之前，先复述一份杂乱的报告

```text
/poteto-mode read this thread. restate the underlying issue in your own words, in plain english. don't change any code yet.
```

理解错了会在复述里暴露出来，这时纠正只需要一条消息。在 agent 说出它自己的理解之前，先别说你的猜测。`/in-your-own-words` 只要求复述，不走任何 playbook。

<a id="sharpen-a-prompt-before-you-send-it"></a>
## 发送之前先打磨 prompt

```text
/sharpen write the onboarding doc for the new billing service.
```

agent 会指出一个专家会做、而你没有要求的事：他们会从哪些原始材料入手，用什么方法和工具，以及用什么外部检查来确认结果是对的。它把你的 prompt 改写成要求这些东西的版本交还给你，自己不做这个任务。觉得改写读起来对了，就把它发出去。

<a id="prototype-before-you-pick"></a>
## 先做原型再选

```text
/poteto-mode prototype a few options for the settings layout. put them behind a switcher and send me screenshots of each.
```

你是在能运行的东西之间挑选，而不是在描述之间挑选。agent 在过程中会自己回答布局和时序上的问题。

<a id="turn-a-settled-design-into-a-plan"></a>
## 把定下来的设计变成计划

```text
/poteto-mode turn this design into a plan. small verifiable PRs, each with its own proof.
```

等设计定下来之后再提这个要求。计划本身就是交付物，而且它会写明由哪个 playbook 来执行。

<a id="get-a-second-opinion-on-a-design"></a>
## 给设计找第二意见

```text
ask /arena for a second opinion on this thread and our approach
```

你当前的设计会成为几个候选之一，综合结论会告诉你评审小组是找到了更好的方案，还是确认了你原来的方案。和一个撤回代价很高的设计相比，这点成本很小。

<a id="check-independent-slices-in-parallel"></a>
## 并行检查互相独立的几块

```text
/swarm check every package under packages/ against its check.sh. one worker per package. one report.
```

每个 worker 负责一个包。父 agent 会等每一块都完成，然后返回一份 `PASS`、`ISSUES` 或 `BLOCKED` 的报告，而不是把各个 worker 的原始输出直接倒给你。

<a id="review-a-branch-skeptically"></a>
## 带着怀疑审查一个分支

```text
/interrogate the whole branch, but skeptically. don't change anything yet. no nitpicks unless it's an actual bug or regression in behavior.
```

这些限定语是真的有用。“don't change anything yet”让它保持只读，挑刺规则则预先滤掉了噪音，这样经过验证的发现才值得你花时间看。

<a id="fix-a-bug-through-a-failing-test"></a>
## 通过一个失败的测试来修 bug

```text
/poteto-mode repro the duplicate write first. if there's a cheap test path, /tdd it. then fix and rerun.
```

“if there's a cheap test path”这句很重要。用脆弱的 mock 硬凑出一个测试，证明的东西比直接运行真实命令还少，而 playbook 允许直接这么说。

<a id="repro-and-fix-a-report-with-proof"></a>
## 复现并修复一份报告，附上证据

```text
/poteto-mode repro this with /verify-<app>. if it repros on main, fix it and show me a video as proof.
```

“if it repros on main”让这次运行在 bug 已经不存在时可以提前结束。视频让你在读 diff 之前就能检查修复。

<a id="prove-a-property-tests-rarely-reach"></a>
## 证明测试很少覆盖到的性质

```text
/create-formal-verification-skill the retry queue. a message must never be delivered twice.
```

你会得到：一个在明确范围内对所有情况都检查过的性质；如果代码已经违反了它，一个用你代码里的概念描述的反例；以及一个项目 skill，下一个 agent 在改动这段代码时都会运行它。

<a id="vet-a-number-before-you-post-it"></a>
## 公布一个数字之前先审核它

```text
/benchmark-checklist vet this 40% speedup before it goes in the pr description
```

你会得到更快、更慢、没有可测量的差别、或无法下结论这几种结果之一，并附上运行次数、波动范围，以及是什么限制了这个数字。

<a id="stop-correcting-the-same-mistake"></a>
## 不再纠正同一个错误

```text
/correct agents keep adding new config flags without registering them in the schema
```

修复会以架构、类型、lint 或测试的形式落进仓库，这样下一个 agent 就没法再犯这个错误。

<a id="ask-how-without-starting-the-work"></a>
## 只问怎么做，不开始干活

```text
/poteto-help how do i get poteto-mode to stay on every turn?
```

你会得到一个回答、一个可以发送的 prompt，以及一个指向出处的链接。在你发出那个 prompt 之前，什么都不会运行。

<a id="keep-a-run-honest-while-youre-away"></a>
## 你不在时让运行保持诚实

```text
im going to bed, keep going autonomously until every fixture passes. do not stop. keep a decision log i can audit in the morning.
```

完整的约定在[过夜那一页](./07-overnight.md)。当任务和完成条件已经在对话里说清楚时，这个简短版本就够用。

<a id="redirect-a-drifting-run"></a>
## 把跑偏的运行拉回来

引导用的 prompt 只要一行：

```text
i said the goal is to repro. i did not ask for a fix yet.
```

```text
apply prove it works. show me the real output, not the build log.
```

```text
/unslop that, no emdashes
```

你很少需要更多的字。你需要的是正确的名字，而[原则那一页](./08-principles.md)就是这套词汇。

<a id="get-the-reply-in-plain-words"></a>
## 让回复说大白话

```text
/bro
```

这就是完整的 prompt。[`/bro`](../../plugins/pstack/skills/bro/SKILL.md) 会像一个人对另一个人说话那样重述上一条消息，没有术语，更短。当一条回复技术上很周全、你却还是不知道它说了什么时，就用它。

<a id="catch-up-on-a-chat-you-left-running"></a>
## 赶上一个你放着在跑的对话

```text
/ketchup
```

[`/ketchup`](../../plugins/pstack/skills/ketchup/SKILL.md) 用大白话告诉你自你上一条消息以来变了什么，然后列出每一个等你拍板的事，附上它的选择、证据和风险。汇报期间它什么都不改。

想用看的方式赶上进度，就运行 [`/ketchup-video`](../../plugins/pstack/skills/ketchup-video/SKILL.md)。它用一段带字幕的幻灯片短视频展示发生了什么，并在视频下面用文字列出等你拍板的事。

<a id="the-pitfalls"></a>
## 常见的坑

- **在 prompt 里罗列 skill**。“use /architect then /arena then /interrogate”会打乱 playbook 已经排好的步骤顺序。说清目标和约束就行。只有要覆盖某个默认做法时，才点名某个 skill。
- **模糊的完成条件**。“make it better”没给 `/loop` 任何可以检查的东西。给一个能通过也能失败的命令或产物。
- **一上来就说你对原因的猜测**。你指向哪里，agent 就搜哪里。先让它复述问题，再说出你的直觉。
- **接受第一个设计**。只做一次尝试，会把模型想到的第一个形状定死。要求做原型或用 `/architect`，根据证据来挑。
- **打磨一份抽象的计划**。对一份背后没有代码的计划做对抗式审查，会编造出永远不会发生的风险。用原型解决悬而未决的问题，然后审查实际做出来的东西。
- **多个并行的 agent 共用一个 worktree**。它们会互相覆盖，谁也分不清是哪个 agent 改了什么。给每个 agent 一个自己的 worktree：说“own worktree per attempt”。
- **还没信任循环就开始循环**。一个无法验证自身工作的循环，只会让没检查过的工作来得更快。先让验证 skill 跑通。
- **相信没审核过的数字**。热缓存或被跳过的代码路径都可能造出假的提速。在这个数字被发到任何地方之前，先运行 `/benchmark-checklist`。
- **一次次手动纠正同一个错误**。在对话里纠正一次只能帮到一次运行。`/correct` 修好仓库，让之后的运行都不再犯。
- **用 `/arena` 来追求覆盖面**。`/arena` 把同一份设计或代码任务重复做几遍，然后选一个作为基础，再把各版最好的部分嫁接上去。`/swarm` 才是把工作分成几块或几条声明好的竞速分支，再汇总成一份报告。
- **接受每一条审查评论**。机器人和人一样，都会把真正的问题和噪音放在同一张清单里。`/interrogate` 只保留重新运行能证实的发现，并列出它丢掉了哪些、为什么丢掉，而你两个方向都可以推翻它的判断。
- **把 `auto` 当成模型名**。`auto` 和 `inherit-parent` 的意思是“省略 model 字段，让子 agent 继承父对话的模型”。[安装 pstack](./01-setup.md)那一页讲了这些角色。
- **凭构建通过就报告成功**。构建只证明代码能编译。要求它运行真实的命令、流程、存储的值或性能分析，并期待回复里带着证据。
- **随手写一个 `SKILL.md`**。让它走 [Authoring or modifying a skill playbook](../../plugins/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md)，这样校验和审查才会发生。

指南就到这里。如果你是跳着读过来的，回到[安装 pstack](./01-setup.md)，跑一个真实的任务。习惯是靠用养成的，不是靠读。

返回[指南目录](./README.md)。
