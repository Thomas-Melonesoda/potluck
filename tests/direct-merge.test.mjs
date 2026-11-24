// potluck: the git guardrail blocks an agent's direct merge (stage 5 follow-up
// issue 1, design row S3-A8). Each line is fed to the hook; none is run.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapper = join(import.meta.dir, "../plugins/pstack/hooks/git-guardrail.sh");
const hook = (command) => spawnSync("sh", [wrapper], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: tmpdir() }), encoding: "utf8", env: { ...process.env, HOME: tmpdir() } });

test.each([
  ["plain", ["gh pr merge 5 --squash", "cd x && gh pr merge --auto", "/opt/homebrew/bin/gh pr -R o/r merge 5", "gh -R o/r pr merge 5", "GH_TOKEN=x gh pr merge 5", "gh pr merge 5 -t 'a -h b' -b '--help'", "gh pr \\\n  merge 5", "gh pr mer\\\nge 5", "if true; then gh pr merge 5; fi", "function m { gh pr merge 5; }; m", "echo \"$(gh pr merge 5)\""]],
  ["behind a wrapper", ["env -u GITHUB_TOKEN gh pr merge 5", "/usr/bin/env gh pr merge 5", "timeout -k 5 60 gh pr merge 5", "timeout 60 env GH_TOKEN=x gh pr merge 5", "echo 5 | xargs -I{} gh pr merge {}", "nice gh pr merge 5", "find . -name x -exec gh pr merge 5 ;", "ssh host gh pr merge 5", "noglob gh pr merge 5", "mise exec -- gh pr merge 5"]],
  ["in a script the line runs", ["sh -c 'gh pr merge 5'", "bash -o pipefail -c 'gh pr merge 5'", "gh pr list -q x | xargs -I{} sh -c 'gh pr merge {} --squash'", "env -u X bash -c 'gh pr merge 5'", "sudo -u me bash -c 'gh pr merge 5'", "eval 'gh pr merge 5'", "su -c 'gh pr merge 5'", "parallel 'gh pr merge {}' ::: 1 2", "trap 'gh pr merge 5' EXIT", "watch -n 5 'gh pr merge 5'", "alias m='gh pr merge'", "gh alias set m 'pr merge'", "git -c alias.m='!gh pr merge 5' m"]],
  ["in a script fed to a shell", ["bash <<'EOF'\ngh pr merge 5\nEOF", "echo 'gh pr merge 5' | sh", "bash <<< 'gh pr merge 5'", "sh -c \"$(cat <<'EOF'\ngh pr merge 5\nEOF\n)\"", "eval \"$(echo gh pr merge 5)\""]],
  ["with gh or the subcommand computed", ["GH=gh; $GH pr merge 5", "$(which gh) pr merge 5", "\"$(command -v gh)\" pr merge 5", "gh pr \"$(echo merge)\" 7"]],
  ["through the REST API", ["gh api -X PUT repos/o/r/pulls/5/merge", "gh api --method=PUT /repos/o/r/pulls/5/merge/ -f merge_method=squash", "gh api -iX PUT repos/o/git/pulls/5/merge", "gh api repos/o/r/merges -f base=main -f head=x", "REPO=o/r; gh api -X PUT \"repos/$REPO/pulls/5/merge\"", "gh api -X PUT \"repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pulls/5/merge\"", "gh api -X PUT \"repos/o/r/pulls/$(gh pr view --json number -q .number)/merge\"", "gh api -X PUT \"$GITHUB_API_URL/repos/o/r/pulls/5/merge\"", "R=repos/o/r; gh api -X PUT $R/pulls/5/merge", "gh api -X PUT https://api.github.com/repositories/1/pulls/5/merge"]],
  ["through GraphQL", ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'", "gh api graphql -F query='mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}'", "Q='mutation{mergePullRequest(input:{}){clientMutationId}}'; gh api graphql -f query=\"$Q\"", "gh api graphql --input - <<'EOF'\n{\"query\":\"mutation{mergePullRequest(input:{}){clientMutationId}}\"}\nEOF"]],
])("a direct merge %s is blocked", (_, lines) => {
  for (const line of lines) {
    const r = hook(line);
    expect([line, r.status]).toEqual([line, 2]);
    expect(r.stderr).toContain("blocked a direct merge");
  }
}, 20_000);

test.each([
  ["reads and the merge gate", ["gh pr view 5 --json mergeable", "gh pr merge --help", "gh pr merge 5 --disable-auto", "gh help pr merge", "gh api repos/o/r/pulls/5/merge", "gh api -X HEAD repos/o/r/pulls/5/merge", "gh api --method GET repos/o/merges/pulls -f state=open", "gh api graphql -f query='query { viewer { login } }'", "node x/merge-gate.mjs merge --repo o/r --pr 5 --sha abc"]],
  ["text that mentions a merge", ["git commit -m 'never run gh pr merge'", "git commit -F - <<'EOF'\nblock gh pr merge\nEOF", "grep -rn 'gh pr merge' .", "timeout 60 rg gh pr merge", "echo run gh pr merge 5", "echo 5 | xargs -I{} echo gh pr merge {}", "cat > x.md <<'EOF'\ngh pr merge 5\nEOF", "bun test tests/a.test.mjs -t 'gh pr merge'", "gh pr create --title 'gh pr merge' --body 'gh api -X PUT repos/o/r/pulls/5/merge'", "gh pr comment 5 --body 'do not gh pr merge this'", "gh release create v1 -n 'gh pr merge'", "cd gh && ls pr merge", "cat bin/gh pr merge"]],
  ["API calls that name a merge elsewhere", ["gh api 'search/code?q=mergePullRequest+repo:o/r'", "gh api repos/o/r/contents/src/mergeBranch.ts", "gh api -X PUT repos/o/r/contents/docs/merges -f message=x", "gh api -X DELETE repos/o/r/labels/merges", "gh api -X DELETE repos/o/r/git/refs/heads/pulls/5/merge", "gh api repos/o/r/issues/5/comments -f body='the mergePullRequest mutation, see https://api.github.com/repos/o/r/pulls/5/merge'", "gh api graphql -f body='mergePullRequest is blocked' -f query='mutation($b:String!){addComment(input:{body:$b}){clientMutationId}}'", "gh api graphql -f query='mutation{addComment(input:{body:\"mergePullRequest is blocked\"}){clientMutationId}}'"]],
])("%s pass", (_, lines) => {
  for (const line of lines) expect([line, hook(line).status]).toEqual([line, 0]);
}, 20_000);
