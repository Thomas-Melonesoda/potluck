# 变成你自己的

[English](../guide/09-make-it-yours.md) | **中文**

<!-- translated-from: 09-make-it-yours.md sha256:38e234b3c8e6950d6dd4b0d6ee357fd34c163158852b9163b6fcb7ea1595d71f -->

poteto-mode 是一个人的风格。它底下的 playbook、路由和模型角色，换成你的风格也一样好用。这一页讲：生成你自己的 mode，从一次会话里收集经验，修好仓库让 agent 不再重复犯错，编写一个专注的 skill，以及在信任一个 skill 改动之前先测试它。

起步要比你想的更小。第一天你不需要很多 skill，甚至不需要这整个插件。平实地写 prompt，观察 agent 在哪里失败，当同一个失败出现两次时，再加一个 skill 或一个检查。

<a id="generate-your-own-mode-with-automate-me"></a>
## 用 `/automate-me` 生成你自己的 mode

```text
/automate-me
```

你不用描述自己的风格，因为 [`/automate-me`](../../plugins/pstack/skills/automate-me/SKILL.md) 会从你的历史里读出来。它在当前工作区里挖掘你最近的会话记录，找出反复出现的偏好，涉及你喜欢的回复方式、委派、验证、代码、文字和流程，然后问你哪些模式真的是你。它通过 **plugin-dev:skill-development** skill 的流程起草 `.claude/skills/<your-name>-mode/SKILL.md`，用 [`/unslop`](../../plugins/pstack/skills/unslop/SKILL.md) 过一遍草稿，再从一个 worktree 开出 PR，让你像审查其它改动一样审查它。

每当你的习惯有了变化，就再运行一次：

```text
/automate-me update my mode skill with everything since its last edit
```

更新模式只挖掘这个 skill 上次改动之后的历史。你没有推翻的规则会保留，有新证据的规则会修订，只有出现新模式时才会加新的章节。

<a id="capture-a-sessions-lessons-with-reflect"></a>
## 用 `/reflect` 收集一次会话的经验

一个让你学到东西的任务刚结束时，运行：

```text
/reflect that took way too long. capture what we learned so the next run doesn't repeat it.
```

[`/reflect`](../../plugins/pstack/skills/reflect/SKILL.md) 会读会话记录，只保留能改变未来 agent 工作方式的经验，并把提议分成 `Accepted`、`Rejected` 和 `Backlog` 三类。在改动任何 skill 之前，它会等你批准。只有当一个提议会改变未来的某个决定时，才批准它。一次古怪的会话只是个例，不是规则。

<a id="fix-the-environment-with-correct"></a>
## 用 `/correct` 修好环境

当你一次又一次为同一个错误纠正 agent 时，修复应该落在仓库里，而不是你的下一个 prompt 里。按照牢靠程度给几种做法排个序：

1. 用架构或更好的数据结构，让这个错误根本不可能发生。
2. 用类型，或者用一个报错信息里写明修法的 lint 或 CI 检查来拦住它。
3. 用测试抓住它。
4. 把它写成文档或 agent 规则。agent 跳过一条规则时什么都不会失败，所以这一条排在最后。

人工审查不在这份清单上。一个必须在每个 PR 上都抓同一个错误的审查者，正是这件事要解决的问题。[`/correct`](../../plugins/pstack/skills/correct/SKILL.md) 来做这项工作：

```text
/correct agents keep calling the database client directly instead of going through the repository layer
```

它会读最近的提交、回滚、审查评论，以及解释变通做法的代码注释，然后把错误归成几类。一类错误发生过两次才算数。它按出现频率从高到低修复这些类别，每类一个提交，修在能奏效的最高层级上，并证明每个新检查都会在一个真实的历史错误上失败。它还会在 agent 指令文件里维护一张表，把每条规则和执行它的东西配对，这样没有任何东西执行的规则就会作为重复问题显露出来。回复会列出每一类错误及其证据、选定的层级，以及为什么更高的层级行不通。

不带参数运行时，它会自己从历史里找出这些类别。`/reflect` 和 `/correct` 分工不同。`/reflect` 根据一次会话改进 skill。`/correct` 修改仓库，让一类错误不会再回来。当修复是一条新的边界时，把它和 `/architect` 搭配使用。[同时跑多个项目](./07-overnight.md#run-many-projects-in-parallel)里有一个 prompt，在整个仓库上同时做这两件事。

<a id="author-a-focused-skill"></a>
## 编写一个专注的 skill

当你已经知道想记录下来的工作流程时：

```text
/poteto-mode write a skill for verifying database migrations in this repo
```

写 skill 对应的是 [Authoring or modifying a skill playbook](../../plugins/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md)。它会走 **plugin-dev:skill-development** skill 的流程，校验 frontmatter 和链接，并通过 Opening a PR playbook 交付结果。写给 agent 看的文字比写给人看的标准更高，因为一句没用的话会变成将来某个 agent 照做的指令。让这个 playbook 来守住这个标准，而不是随手写一个 `SKILL.md`。

有两种特殊情况有各自的生成器。一个必须操作你的应用并证明行为的 skill 是验证 skill，所以要改用 [`/create-verification-skill`](../../plugins/pstack/skills/create-verification-skill/SKILL.md) 和 [`/maintain-verification-skill`](../../plugins/pstack/skills/maintain-verification-skill/SKILL.md)。一个用模型检查器、证明或其它验证器来检查代码某个性质的 skill 是形式化验证 skill，所以要用 [`/create-formal-verification-skill`](../../plugins/pstack/skills/create-formal-verification-skill/SKILL.md) 和 [`/maintain-formal-verification-skill`](../../plugins/pstack/skills/maintain-formal-verification-skill/SKILL.md)。[验证结果并开 PR](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill)这一页讲了这两种。

<a id="write-docs-to-a-standard-with-technical-writing"></a>
## 用 `/technical-writing` 按标准写文档

skill 不是你唯一要交付的文字。对于文档、RFC、readme、PR 描述和提交信息：

```text
/technical-writing review the readme changes
```

[`/technical-writing`](../../plugins/pstack/skills/technical-writing/SKILL.md) 应用一套分层的标准。它的目标是写出一个疲惫的工程师读第一遍就能懂的文字。它先选定文档的类型（教程、操作指南、参考或解释），然后逐句处理：谁做了什么，一句话一个意思，没有能读出两种意思的地方。用它来审查你或 agent 刚写好的东西，或者在要求写文档时一开始就点它的名字。

<a id="test-a-skill-change-blind"></a>
## 盲测一个 skill 改动

一次 skill 修改会影响以后的每一次会话，所以要像对待一场实验那样测试它。采用别人的 skill 也一样。留下它之前，先确认它在你的工作上真的让 agent 变得更好。

```text
/poteto-mode run the eval playbook on this skill change. same task for both variants, candidates stay blind.
```

当一个 skill 总是做不对，而你知道它应该怎么做时，就在一个任务里同时修改和测试它：

```text
/poteto-mode update the review skill so it flags missing migrations, and eval the change.
```

一开始就要求做 eval，能让这次修改保持诚实。根据一次糟糕的会话写出来的修复，往往会过度拟合那次会话，而经过许多次修改之后，skill 就会跑偏。eval 能在交付之前抓住这种跑偏。

[Eval playbook](../../plugins/pstack/skills/poteto-mode/playbooks/eval.md) 是围绕一种失败模式设计的：观察者效应。知道自己正在被评估的 agent，表现会不一样。所以候选 agent 拿到的是一个看起来很自然的任务，放在清理过的目录里，绝不会看到“eval”或“candidate”这两个词，也绝不知道彼此的存在。一个评判者在中性的标签下给所有输出打分，而是否按链路读文件，是根据每个候选实际读了哪些文件来评分的，不看它自己怎么说。

接受结论之前，每份输出都要亲自读一遍。如果你和评判者意见不同，先怀疑评分标准，再怀疑你自己的判断。

**坑**：不要因为一个 skill 表现不对，就在任务中途修改它。在它自己的 PR 里修，让任务继续推进。和功能工作缠在一起交付的 skill 修改，在审查里是看不见的，也没法评估。

下一页：[配方和坑](./10-recipes-and-pitfalls.md)。
