# potluck

potluck is built on Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated skill stack that improves agent outcomes. It forks Michael Denyer's port for Claude Code, Codex, and other agent harnesses: the same skills, with Cursor primitives translated to each runtime's tools.

Tell `poteto-mode` your goal and it invokes the workflow that fits: reproduce and root-cause a bug, sketch a design with `architect`, race candidates in `arena`, review a diff with `interrogate`, cut prose with `unslop`. It keeps code concise, simple, and verified, and it reports what it checked.

## What it contains

- Skills: Markdown instructions the agent reads. Public ones appear as `/pstack:<name>` slash commands.
- Agents: `pstack:poteto-agent` and `pstack:comment-sicko`.
- A SessionStart hook that injects the poteto-mode routing mandate unless your `pstack-models.md` sheet turns it off.
- A Pi extension that supplies the subagent, question, and wake-up tools, `/loop`, and the same routing mandate when the repository is installed as a Pi package.
- Local scripts for watching and shipping pull requests, orchestrating multi-phase plans, and auditing worktrees.

## Data handling

pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Links

- [Skills, slash commands, runtime setup, and model configuration](https://github.com/Thomas-Melonesoda/potluck/blob/main/docs/reference.md)
- [Issues and support](https://github.com/Thomas-Melonesoda/potluck/issues)
- [Security policy](https://github.com/Thomas-Melonesoda/potluck/blob/main/SECURITY.md)

## License

MIT. Original pstack © 2026 Lauren Tan; the pstack-claude port © 2026 Michael Denyer; potluck's additions © 2026 Thomas-Melonesoda; imported cursor-team-kit skills © 2026 Cursor. See [NOTICE.md](https://github.com/Thomas-Melonesoda/potluck/blob/main/NOTICE.md).
