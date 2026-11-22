---
name: grill-stays-quiet-on-small-fix
tags: [layer3, grill]
runs: 1
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Rename the variable `tmp` to `total` in this function and show me the result:

function sum(values) { let tmp = 0; for (const v of values) tmp += v; return tmp; }
