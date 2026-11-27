# Merges that broke a rule

A merge that skipped a step `AGENTS.md` says may not be skipped is recorded here: what was skipped, what was made up afterwards, and what is still missing. Only the owner may waive such a step, in their own words and with the date, so an entry here is a violation, not a waiver.

## #50, 2026-11-24

[#50](https://github.com/Thomas-Melonesoda/potluck/pull/50) (`59eab4f`, "expected checks decide when a PR has no checks") merged without meeting two conditions that applied then:

- **No real run before the merge.** It changed behavior a user can trigger, and no harness run was pasted into the PR.
- **Over the size limit.** It added 502 lines, above the 400-line limit `AGENTS.md` had at the time. The owner removed that limit on 2026-11-25, but it applied when #50 merged.

Made up afterwards: a real run after the merge covered three of its five cases before it reached its spending cap, at $0.21.

Still missing: the other two cases never ran. The merge gate script #50 changed was retired on 2026-11-25, so they cannot be run against the code they were written for.

The owner asked for this record in their written answers to the stage 5 round 2 and 3 questions (root decision, 2026-11-24): "#50 这次两条没做到就合并了，在决定日志里记一笔违规，写明后来补跑了哪些、还缺哪些" (Chinese: #50 merged with two conditions unmet; record a violation saying what was run afterwards and what is still missing).
