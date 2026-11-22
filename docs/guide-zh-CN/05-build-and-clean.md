# 构建改动，清理 diff

[English](../guide/05-build-and-clean.md) | **中文**

<!-- translated-from: 05-build-and-clean.md sha256:4516b864cb425bf9699aa7e221a9597a0fa74f62c023f14fb4d3c8494f9ed9c5 -->

各个构建 playbook 遵循同一套做法：说出你观察到的情况，让 playbook 去要证据。这一页说明常见的构建任务各该在 prompt 里写什么，然后介绍让 diff 保持易于审查的清理习惯。

<a id="prompt-each-build-playbook-with-what-you-know"></a>
## 给每个构建 playbook 写上你已知的情况

修 bug 的 prompt 说明症状，并要求先复现：

```text
/poteto-mode this command emits two records after a retry. repro first, then fix and verify.
```

做功能的 prompt 说明要的行为，以及什么不能变：

```text
/poteto-mode add a --json flag. text output stays byte-identical. verify both forms.
```

重构的 prompt 在挪动结构之前先把行为固定下来：

```text
/poteto-mode move parsing into one module, zero behavior change. record the current output first and prove it's unchanged after.
```

性能的 prompt 说明测量结果，而不是印象：

```text
/poteto-mode startup takes 1.8s on this fixture. trace it, fix the measured cause, show me before and after.
```

这些 prompt 各自会转到对应的 playbook（[Bug fix](../../plugins/pstack/skills/poteto-mode/playbooks/bug-fix.md)、[Feature](../../plugins/pstack/skills/poteto-mode/playbooks/feature.md)、[Refactoring](../../plugins/pstack/skills/poteto-mode/playbooks/refactoring.md)、[Perf issue](../../plugins/pstack/skills/poteto-mode/playbooks/perf-issue.md)），playbook 会补上你没写的步骤：修之前先复现，实现之前先说清数据的形状，重组之前先固定行为，优化之前先做性能分析。

如果要持续改进某一个数字，有 [Hillclimb playbook](../../plugins/pstack/skills/poteto-mode/playbooks/hillclimb.md)。给它指标、目标和最少尝试次数，它就一次验证一个假设地循环下去，测量用的 harness 固定不变。有效的改动留下，其余的全部撤回。

两个性能 playbook 都会对自己的数字运行 [`/benchmark-checklist`](../../plugins/pstack/skills/benchmark-checklist/SKILL.md)。Perf issue 会审查它的基线以及之后的每个数字，Hillclimb 在固定 harness 之前先审查它。[验证结果并开 PR](./06-verify-and-ship.md#vet-a-measured-number-with-benchmark-checklist)说明了什么时候该你自己输入这个命令。

有时你想在动手修之前先弄清原因。对于正在发生的症状，比如内存泄漏、空闲时 CPU 空转或画面故障，[Runtime forensics playbook](../../plugins/pstack/skills/poteto-mode/playbooks/runtime-forensics.md) 会给运行中的进程加上监测。对于你已经采集好的性能分析文件，[Trace forensics playbook](../../plugins/pstack/skills/poteto-mode/playbooks/trace-forensics.md) 会读这个文件，把最耗时的调用帧对应到源代码上。两者给出的都是诊断，不是修复：

```text
/poteto-mode here's a cpuprofile from the slow startup. tell me where the time goes and which source lines own it. no fix yet.
```

<a id="write-the-failing-test-first-with-tdd"></a>
## 用 `/tdd` 先写失败的测试

当一个 bug 在本地有低成本的测试路径时，整个 prompt 可以只有两个词：

```text
/tdd implement
```

在有上下文的情况下，这就够了。[`/tdd`](../../plugins/pstack/skills/tdd/SKILL.md) 先写一个最小的、因为预期原因而失败的测试，然后写修复，再重跑测试。如果一个测试需要大量 harness 搭建或者脆弱的 mock，这个 skill 会直说，并改用最接近的可执行检查。真实命令是更有力的证据时，不要硬塞一个测试。

<a id="load-the-typescript-rules-by-name"></a>
## 点名加载 TypeScript 规则

[`typescript-best-practices`](../../plugins/pstack/skills/typescript-best-practices/SKILL.md) 把类型系统方面的原则落实成具体规则：可辨识联合、在边界处使用 `unknown`、穷尽所有变体、从 schema 推导类型。它不会自动加载，所以任务涉及 `.ts` 或 `.tsx` 文件时，输入 `/typescript-best-practices`。

<a id="clean-before-you-commit"></a>
## 提交之前先清理

[Opening a PR playbook](../../plugins/pstack/skills/poteto-mode/playbooks/opening-a-pr.md) 在每次提交前对 diff 运行 `/deslop`，poteto-mode 会对 PR 描述和提交说明应用 [`/unslop`](../../plugins/pstack/skills/unslop/SKILL.md)。`/deslop` 随 potluck 一起提供，沿用自 Cursor 的 `cursor-team-kit`。

对于文字，`/unslop` 接受一个目标和你额外的规则：

```text
/unslop the readme changes, no emdashes
```

你会形成自己的简写。这个 skill 从很简短的 prompt 里也能读懂意图，比如 `unslop that, tighten it`。

<a id="strip-the-comments-with-no-comments"></a>
## 用 `/no-comments` 去掉注释

注释需要单独过一遍，而且不能由写它们的 agent 来做。作者会为自己的注释辩护，就像你会为你的注释辩护一样。所以在审查之前，把它们交给一双新的眼睛：

```text
/no-comments the diff
```

[`/no-comments`](../../plugins/pstack/skills/no-comments/SKILL.md) 会启动 [Comment Sicko](../../plugins/pstack/agents/comment-sicko.md)，一个只读的审查者，它只保留很短的一份清单：许可证头、公开 API 上的文档注释、解释代码本身说不清的内容的链接、由你无法改动的外部依赖所决定的行为。其它的都删掉。你自己代码里的意外之处不能这样过关。这条注释会变成一个重构标记返回，`/no-comments` 会从根本原因上修复它认可的那些标记。当一条注释声称存在某种约束，比如“不要删除”，这个 skill 会提议把这个说法写成类型、测试或 lint。不管哪种情况，注释都会被删掉。

分工值得记清楚。`/deslop` 清理代码里的冗余，`/unslop` 清理文字里的冗余，`/no-comments` 把注释交给一个不是作者的审查者。

**陷阱**：清理不是可有可无的润色。一个充满解说式注释和防御性冗余代码的 diff，在审查者看来就是没做完，而多出来的代码正是下一个 bug 藏身的地方。如果 diff 显得臃肿，在提交之前就说 `deslop it`，不要等审查指出来。

下一页：[验证结果并开 PR](./06-verify-and-ship.md)。
