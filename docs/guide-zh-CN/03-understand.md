# 改代码之前先理解它

[English](../guide/03-understand.md) | **中文**

<!-- translated-from: 03-understand.md sha256:a6cdf22c63cb55931c45f4b9f5e858dd3b4c63e4ee69583243bb8cd6ab474008 -->

改你不理解的代码，正是细微回归被发布出去的原因，这一点对 agent 和对你都一样。agent 通常以两种方式之一失败：要么误解了你想要什么，要么缺少把事情做对所需的上下文。[prompt 里写什么](./02-poteto-mode.md#what-goes-in-a-prompt) 解决第一种。这一页解决第二种。

pstack 给你四个切入口。`/how` 解释代码现在做什么。`/why` 挖出它为什么是这个样子。`/teach` 把两者融合成一份解释。`/recall` 帮你重建自己最近在某个话题上的上下文。每一个也都会让 agent 用你能核对的话解释自己。这就是你监督一个可能比你更懂代码的 agent 的方式。

![一位侦探拿着放大镜研究机器蓝图，机器人在帮她取案卷；她身后的证据板在 /how 和 /why 下面把线索连了起来。](../guide/images/understanding.jpg)

<a id="start-with-a-read-only-investigation"></a>

## 从只读调查开始

原因不明时，要调查结果，不要修复：

```text
/poteto-mode investigate why background jobs time out every few hours. give me what we know, what data you used, and your best hypotheses. don't change any code yet.
```

"don't change any code yet"（先别改代码）会把它分派到 [Investigation playbook](../../plugins/pstack/skills/poteto-mode/playbooks/investigation.md)。它会追踪代码，遇到关于动机的问题就加上 `/why`，并返回一份带引用的解释。如果是在几个选项之间做选择，它会返回一个推荐，附带权衡表。问"what data you used"（你用了哪些数据），会让 agent 把证据和猜测分开。调查结果指向某个修复时，把修复作为新任务开始。

<a id="trace-behavior-with-how"></a>

## 用 `/how` 追踪行为

```text
/how do we dedupe notifications? is there an n+1 when we look up subscribers?
```

问你真正想问的问题。[`/how`](../../plugins/pstack/skills/how/SKILL.md) 会读代码，以资深工程师带你熟悉这个子系统的水平来回答，讲清运行时流程、关键类型和不显而易见的部分。它会启动一个只读子 agent，去探索代码并写出解释。

<a id="dig-up-history-with-why"></a>

## 用 `/why` 挖出历史

```text
/why was the retry limit set to five? does the reason still hold?
```

[`/why`](../../plugins/pstack/skills/why/SKILL.md) 根据记录回答，而不是根据代码。它会读引入这段代码以及之后每次修改的 commit 和 PR 讨论，在这条线索太少时还会看其它来源。答案会引用作者写下的内容，把 agent 自己的推断标为推断，并说明记录里回答不了的部分，因为"没人写下原因"本身就是一个答案。

两者可以自然地组合。当你怀疑历史能解释这团乱麻时，`do why first then how` 是一条好 prompt。

<a id="actually-understand-it-with-teach"></a>

## 用 `/teach` 真正弄懂

```text
/teach me how this PR changes retries. convince me it fixes the cause and not the symptom.
```

[`/teach`](../../plugins/pstack/skills/teach/SKILL.md) 用在摘要不够的时候。它会运行 `/how` 和 `/why`（对小改动可能只运行其中一个），把结果编织成一份通俗的解释，一张图一张图地搭起来。"convince me"（说服我）这种说法值得反复用。它把解释变成一个你可以检验的论证，而不是一次参观。

它也适用于 agent 自己做的选择：

```text
/teach me why you implemented it this way and not with a queue. what did you trade off, and why?
```

教学对 agent 的帮助和对你一样大。一个必须解释自己工作的 agent，得去读代码，并用证据支撑每一个说法，而不是自信地说完就往下走。

<a id="rebuild-your-own-context-with-recall"></a>

## 用 `/recall` 重建你自己的上下文

```text
/recall catch me up on the export work from last week
```

[`/recall`](../../plugins/pstack/skills/recall/SKILL.md) 会挖掘你自己最近的对话，加上共享记录（issue、之前的修复、仍在报的错误），交回一份简报，说明事情进展到哪里、下一步是什么。你的旧对话里有新 agent 缺少的上下文，所以在老话题上开始新工作时，先把它加载进来，再交给它新的输入：

```text
/recall my work on the virtualized list from yesterday, then read this bug report.
```

如果你想接着某一个特定的对话做，那要用下面的 Session pickup playbook，而不是 `/recall`。

<a id="take-over-prior-work-with-session-pickup"></a>

## 用 Session pickup 接手之前的工作

当另一个 agent（或者上周的你）留下一个做到一半的分支时：

```text
/poteto-mode take over this branch. read the decision log, figure out what's done, and continue from there. don't redo finished work.
```

[Session pickup playbook](../../plugins/pstack/skills/poteto-mode/playbooks/session-pickup.md) 把之前留下的记录当作权威。它会重建分支状态和各项决定，指出从哪里继续，并对照原始目标核实继承下来的说法，而不是从头重新推一遍。

**陷阱：** 不要因为"agent 反正会读代码"就跳过这一页的 skill。没有先追踪出一个模型就开始改的 agent，往往会在第一个看起来说得通的地方修掉症状。先用 `/how`，比出第二个 bug 便宜。

下一页：[写代码之前先做设计](./04-design.md)。
