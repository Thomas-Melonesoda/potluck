#!/usr/bin/env node
// potluck: the deterministic merge gate (design row A8).
//
//   node merge-gate.mjs verdict --repo <owner/repo> --sha <head> --state pass|fail [--description <text>]
//   node merge-gate.mjs merge --repo <owner/repo> --pr <number> --sha <verified head> [--author-email <email>] [--dry-run]
//   node merge-gate.mjs cosign --repo <owner/repo> --pr <number> --sha <head> --log <decision log> --evidence <pointer> [--why <text>]
//
// `verdict` records a verifier's result as the `potluck/verdict` commit status
// on that exact head, so the result is a fact GitHub holds, not a comment.
//
// `merge` only checks facts, then merges. It refuses unless every one holds:
//   - the PR is open, not a draft, not conflicting, and its head is the
//     verified SHA
//   - that head carries a `potluck/verdict` status of success
//   - every other check run and commit status on that head finished green
//   - the quality floor passes on that head (design rows D5 and A8): Addy
//     Osmani's floor guard, taken from the synced constraint-driven-development
//     skill with potluck's declared fork, runs in a throwaway clone of the
//     verified head (sharing the checkout's objects, none of its config)
//     against the PR's base. It refuses a change that lowers the
//     bar: a weakened CONSTRAINTS.md, a test made easier, a new suppression
//     comment, a stub or empty catch, a new exception row. It reads every file
//     that runs and leaves only plain .md unchecked, and CONSTRAINTS.md's own
//     rule checks always run. A guard that cannot run refuses too. Run the gate
//     from a checkout whose origin is the repo. A changed assertion passes
//     only with the root agent's co-sign on that head for those findings.
//   - the project's docs/overview.md is current with its sources and every
//     ticked Done when item names its proof (grill/scripts/overview.mjs
//     --check), when the project has those sources
//   - every check the PR should get has reported and finished green (stage 5
//     issues 4, 5, and 16): each workflow in the base or the head that runs on
//     pull_request has a finished, green Actions run on the head (a run that is
//     waiting, queued, or waits for a maintainer's approval has not finished),
//     and each check the base branch's rulesets or protection require has
//     reported. One that has not reported refuses while CI may still start, and
//     after --ci-wait minutes (default 10) from the head's push it refuses as
//     CI that did not start. A workflow limited to some paths or branches
//     is waited for when the PR touches them, and skipped when it does not.
//   - a PR with no such check and no CI result has "no checks": potluck's
//     default merges it on the verdict alone, and the operator's gates
//     (gates.mjs) can hold it for a person with noCI "wait" in the user's
//     ~/.potluck/gates.json or in .potluck/gates.json at the PR's base or head.
// It merges with `gh pr merge --squash --match-head-commit <sha>`, never
// `--auto`, so GitHub itself refuses if the head moves after the checks, and
// it reads the PR back to confirm the merge.
//
// `cosign` is the root agent's step for a changed assertion (stage 5 issue
// 17), taken once it has checked the verifier's evidence that the behavior
// really changed. It needs a passing verdict on the head and a floor whose
// only findings are changed assertions. It appends a row to the root agent's
// decision log (show-me-your-work's log.sh) and records a `potluck/cosign`
// status on the head whose description ends in a fingerprint of those
// findings, so a new head or different findings need a new co-sign.
//
// Output is one JSON line: { kind: "merged" | "would-merge" | "held" |
// "refused" | "unconfirmed" | "recorded", ... }; a PR with no checks carries
// checks: "none". "unconfirmed" means the merge was requested
// but not read back as merged, so it may have landed. Exit 0 on merged,
// would-merge, or recorded; 1 on held, refused, or unconfirmed; 2 on a usage
// error.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { FLOOR_GUARD, guardSource } from "./floor.mjs";
import { parseGates, REPO_FILE, strictest, userFile } from "./gates.mjs";
import { prTrigger } from "./pr-trigger.mjs";

export { FLOOR_GUARD, guardSource };
export const CONTEXT = "potluck/verdict";
export const COSIGN = "potluck/cosign";
// The only floor findings a co-sign clears. Every other finding refuses outright.
const COSIGNABLE = /^\[assertion-(changed|moved)\] /;
const fingerprint = (findings) => createHash("sha256").update([...findings].sort().join("\n")).digest("hex").slice(0, 16);
export const LOG = join(dirname(fileURLToPath(import.meta.url)), "../../show-me-your-work/scripts/log.sh");
const GREEN = new Set(["success", "neutral", "skipped"]);
const SHA = /^[0-9a-f]{40}$/;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}
const ghJson = (args) => JSON.parse(gh(args));

// Every page of a REST list, concatenated (`--paginate --slurp` gives an array of pages).
function pages(path, field) {
  const all = ghJson(["api", "--paginate", "--slurp", path]);
  return all.flatMap((page) => (field ? page[field] : page));
}

// Reads the facts the gate decides on. `read` is injectable for tests.
export function readFacts(repo, pr, sha, read = { ghJson, pages }) {
  const view = read.ghJson([
    "pr", "view", String(pr), "--repo", repo,
    "--json", "state,isDraft,headRefOid,headRefName,mergeable,baseRefName,baseRefOid",
  ]);
  const statuses = read.pages(`repos/${repo}/commits/${sha}/statuses`);
  const runs = read.pages(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, "check_runs");
  return { view, statuses, runs };
}

// The newest status per context; GitHub lists statuses newest first.
function latestByContext(statuses) {
  const latest = new Map();
  for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, s);
  return latest;
}

// Pure decision: the reasons the gate refuses, or [] when it may merge.
export function refusals({ view, statuses, runs }, sha) {
  const reasons = [];
  if (view.state !== "OPEN") reasons.push(`PR is ${view.state}, not OPEN`);
  if (view.isDraft) reasons.push("PR is a draft");
  if (view.mergeable === "CONFLICTING") reasons.push("PR conflicts with its base");
  if (view.headRefOid !== sha) reasons.push(`head is ${view.headRefOid}, not the verified ${sha}`);

  const latest = latestByContext(statuses);
  const verdict = latest.get(CONTEXT);
  if (!verdict) reasons.push(`no ${CONTEXT} status on ${sha}`);
  else if (verdict.state !== "success") reasons.push(`${CONTEXT} is ${verdict.state} on ${sha}`);

  for (const [context, s] of latest) {
    if (context === CONTEXT || context === COSIGN) continue;
    if (s.state === "pending") reasons.push(`status ${context} is still pending`);
    else if (s.state !== "success") reasons.push(`status ${context} is ${s.state}`);
  }
  for (const run of runs) {
    if (run.status !== "completed") reasons.push(`check ${run.name} is still ${run.status}`);
    else if (!GREEN.has(run.conclusion)) reasons.push(`check ${run.name} concluded ${run.conclusion}`);
  }
  return reasons;
}

// Formats that are binary by nature. Any other changed file must diff as text.
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|heic|pdf|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|flac|mov|webm|avi|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|so|dylib|dll|exe|class|pyc|o|a|lib|sqlite3?|db|lockb|docx?|xlsx?|pptx?|keynote|sketch|fig)$/i;

const gitIn = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity, timeout: 300_000 });

export const OVERVIEW = join(dirname(fileURLToPath(import.meta.url)), "../../grill/scripts/overview.mjs");

// The project overview (design rows R2 and R4) must match the sources grill
// writes, and no Done when item may be ticked without its proof. A project
// with none of those sources needs no overview and passes.
function overviewCheck(tree, env, head) {
  const run = spawnSync(process.execPath, [OVERVIEW, "--root", tree, "--check"], { cwd: tree, env, encoding: "utf8", timeout: 120_000 });
  if (run.status === 0) return { ok: true, reasons: [], ...head };
  const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  if (run.status === 1) return { ok: false, reasons: lines.map((l) => `overview: ${l}`) };
  return { ok: false, reasons: [`overview check could not run: ${lines[0] ?? `exit ${run.status ?? run.signal}`}`] };
}

// GitHub skips push and pull_request workflows for a head commit whose message says so.
const SKIP_CI = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: ?true$/im;

// The fingerprint a passing co-sign on the head names, or null.
function cosignOf(statuses) {
  const s = latestByContext(statuses).get(COSIGN);
  return s?.state === "success" ? (s.description?.match(/\b([0-9a-f]{16})$/)?.[1] ?? null) : null;
}

// Runs the floor guard on the verified head. Returns { ok, reasons } and, when
// ok, what the head says about its CI and the repository's gates files; plus
// `cosign`, the findings' fingerprint, when a co-sign could clear them all.
export function floor({ repo, pr, sha, view, cosigned = null, cwd = process.cwd() }) {
  let top;
  try {
    top = gitIn(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return { ok: false, reasons: [`floor guard could not run: ${cwd} is not a git checkout; run the gate from a checkout of ${repo}`] };
  }
  const origin = (() => {
    try {
      return gitIn(top, ["remote", "get-url", "origin"]).trim();
    } catch {
      return "";
    }
  })();
  const [owner, name] = repo.toLowerCase().split("/");
  const slug = origin.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!slug.endsWith(`/${owner}/${name}`) && !slug.endsWith(`:${owner}/${name}`)) {
    return { ok: false, reasons: [`floor guard could not run: origin of ${top} is not ${repo}`] };
  }
  let source;
  try {
    source = guardSource();
  } catch (error) {
    return { ok: false, reasons: [`floor guard could not run: ${error.message.split("\n")[0]}`] };
  }
  const scratch = mkdtempSync(join(tmpdir(), "potluck-floor-"));
  const tree = join(scratch, "tree");
  // The guard runs in a throwaway clone that shares the checkout's objects but
  // none of its config, hooks, or worktrees, with global and system config off.
  // Attributes come from the base commit, so a PR's own .gitattributes cannot
  // mark files -diff or binary; renames are off by default, and the guard asks
  // for them only where a test file kept a name its runner reads; colour and
  // path quoting are off, so the guard reads plain names.
  // Variables that would point git elsewhere or swap its diff are dropped.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|EXTERNAL_DIFF|DIFF_OPTS|ATTR_SOURCE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|NAMESPACE|CEILING_DIRECTORIES|COMMON_DIR)$/.test(k)),
  );
  const env = {
    ...inherited,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "diff.renames", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "color.ui", GIT_CONFIG_VALUE_1: "never",
    GIT_CONFIG_KEY_2: "color.diff", GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "core.quotePath", GIT_CONFIG_VALUE_3: "false",
  };
  let attrs = {};
  const isolated = (args) => execFileSync("git", ["-C", tree, ...args], { encoding: "utf8", env: { ...env, ...attrs }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity, timeout: 300_000 });
  try {
    gitIn(top, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `refs/pull/${pr}/head`, `refs/heads/${view.baseRefName}`]);
    gitIn(top, ["cat-file", "-e", `${sha}^{commit}`]);
    const base = view.baseRefOid && /^[0-9a-f]{40}$/.test(view.baseRefOid) ? view.baseRefOid : null;
    if (!base) return { ok: false, reasons: ["floor guard could not run: GitHub gave no base commit for the PR"] };
    gitIn(top, ["cat-file", "-e", `${base}^{commit}`]);
    // A fresh repository that borrows the checkout's objects through
    // alternates (git clone --shared silently copies instead from a shallow
    // source, and would miss the fetched head), plus its shallow boundary.
    execFileSync("git", ["init", "--quiet", tree], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    const objects = join(gitIn(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), "objects");
    writeFileSync(join(tree, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const shallow = gitIn(top, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]).trim();
    if (existsSync(shallow)) copyFileSync(shallow, join(tree, ".git", "shallow"));
    // From here, attributes come from the base commit, so the PR's own
    // .gitattributes can neither re-encode files on checkout nor hide a diff.
    attrs = { GIT_ATTR_SOURCE: base };
    isolated(["checkout", "--quiet", "--detach", sha]);
    const changed = isolated(["diff", "--name-only", "-z", base, "HEAD"]).split("\0").filter(Boolean);
    // The guard reads text diffs only, so any changed file git sees as binary
    // (one NUL byte is enough) would hide every finding in it. Only known
    // binary formats (images, fonts, media, archives, documents) may be binary.
    const numstat = isolated(["diff", "--numstat", "-z", base, "HEAD"]).split("\0").filter(Boolean);
    // A deleted file hides nothing, so only files present in the head count.
    const present = new Set(isolated(["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean));
    const opaque = numstat.filter((l) => /^-\t-\t/.test(l)).map((l) => l.slice(4)).filter((f) => present.has(f) && !BINARY.test(f));
    if (opaque.length) return { ok: false, reasons: opaque.map((f) => `floor: [binary-source] ${f}: git reads this file as binary, so the floor cannot check it; remove the NUL or control bytes, or use a binary format's usual extension`) };
    // Workflows count from the base or the head, so a PR cannot escape the
    // no-CI rule by deleting or renaming the CI it would have to pass.
    const workflowFiles = (rev) => isolated(["ls-tree", "--name-only", "-z", rev, ".github/workflows/"]).split("\0").filter((f) => /\.ya?ml$/.test(f));
    const workflows = [base, "HEAD"].some((rev) => workflowFiles(rev).length);
    // The workflows that run on this PR, read from the base or the head, so a
    // PR cannot drop one it would have to pass by deleting or editing it. Path
    // filters read the PR's own diff, from where it left its base.
    const into = {
      base: view.baseRefName,
      changed: isolated(["diff", "--name-only", "--ignore-submodules=none", "-z", `${base}...HEAD`]).split("\0").filter(Boolean),
      commits: Number(isolated(["rev-list", "--count", `${base}..HEAD`])),
    };
    const prWorkflows = new Set();
    for (const rev of [base, "HEAD"]) {
      for (const file of workflowFiles(rev)) if (prTrigger(isolated(["cat-file", "blob", `${rev}:${file}`]), into)) prWorkflows.add(file);
    }
    // A PR that changes the workflows, or whose head skips CI, may be why it
    // has no checks. The repository's gates count from the base and the head,
    // so a PR cannot loosen the gates it is judged by.
    const repoGates = [[base, "base"], ["HEAD", "head"]].flatMap(([rev, at]) => {
      try {
        return [{ source: `${REPO_FILE} at the PR's ${at}`, text: isolated(["cat-file", "blob", `${rev}:${REPO_FILE}`]) }];
      } catch {
        return [];
      }
    });
    const head = {
      workflows,
      prWorkflows: [...prWorkflows],
      committedAt: isolated(["log", "-1", "--format=%cI", "HEAD"]).trim(),
      skipsCI: SKIP_CI.test(isolated(["log", "-1", "--format=%B", "HEAD"])),
      repoGates,
    };
    const script = join(scratch, "floor-guard.mjs");
    writeFileSync(script, source);
    const run = spawnSync(process.execPath, [script, "--base", base], { cwd: tree, env: { ...env, ...attrs }, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (run.status === 0) return overviewCheck(tree, env, head);
    if (run.status === 1) {
      const findings = lines.map((l) => l.trim()).filter((l) => /^\[[a-z-]+\] /.test(l));
      const cosign = findings.length && findings.every((f) => COSIGNABLE.test(f)) ? fingerprint(findings) : null;
      if (cosign && cosign === cosigned) return overviewCheck(tree, env, head);
      return { ok: false, cosign, reasons: (findings.length ? findings : lines).map((l) => `floor: ${l.trim()}`) };
    }
    return { ok: false, reasons: [`floor guard could not run: ${lines[0] ?? `exit ${run.status ?? run.signal}`}`] };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    return { ok: false, reasons: [`floor guard could not run: ${detail}`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The required checks the base branch's rulesets and classic protection
// name. A repository without either (404, or 403 on a plan without them) has none.
export function requiredChecks(repo, branch, read = { ghJson }) {
  const names = new Set();
  const tryRead = (args) => {
    try {
      return read.ghJson(args);
    } catch (error) {
      if (/HTTP 40[34]/.test(String(error?.stderr || error?.message || error))) return null;
      throw error;
    }
  };
  for (const rule of tryRead(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]) ?? []) {
    if (rule.type === "required_status_checks") for (const c of rule.parameters?.required_status_checks ?? []) names.add(c.context);
  }
  const classic = tryRead(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`]);
  for (const c of classic?.checks ?? []) names.add(c.context);
  for (const c of classic?.contexts ?? []) names.add(c);
  return [...names];
}

// When the head was pushed: the branch's push activity, else the head commit's
// date (no later than its push), so a fork's head waits no longer than its own.
function pushedAt(repo, view, committedAt) {
  if (view.headRefName) {
    try {
      const pushes = ghJson(["api", `repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${view.headRefName}`)}&activity_type=push&per_page=100`]);
      const push = pushes.find((p) => p.after === view.headRefOid);
      if (push) return Date.parse(push.timestamp);
    } catch (error) {
      if (!/HTTP 40[34]/.test(String(error?.stderr || error?.message || error))) throw error;
    }
  }
  return Date.parse(committedAt);
}

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

// Why the head's CI is not done: a PR workflow or a required check that has
// not finished green, or has not reported; null when every expected check has.
export function expectedBlocker({ prWorkflows, wfRuns, required, runs, statuses, pushed, now, waitMs }) {
  const missing = [];
  for (const path of prWorkflows) {
    // Only pull request runs count, so a newer push or manual run of the same
    // file cannot stand in for one that has not finished.
    const prRuns = wfRuns.filter((r) => (r.path === path || r.path?.startsWith(`${path}@`)) && PR_EVENTS.has(r.event)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (!prRuns.length) {
      missing.push(path);
      continue;
    }
    const unfinished = prRuns.find((r) => r.status !== "completed");
    if (unfinished) return `${path} is ${unfinished.status}, so it has not finished`;
    if (!GREEN.has(prRuns[0].conclusion)) return `${path} concluded ${prRuns[0].conclusion}`;
  }
  const reported = new Set([...runs.map((r) => r.name), ...statuses.map((s) => s.context)]);
  for (const name of required) if (!reported.has(name)) missing.push(`the required check ${name}`);
  if (!missing.length) return null;
  const list = missing.join(", ");
  if (now - pushed < waitMs) return `${list} ha${missing.length === 1 ? "s" : "ve"} not reported, and CI may not have started yet; rerun in a minute`;
  return `CI did not start: ${list} never reported within ${Math.round(waitMs / 60_000)} minutes of the push at ${new Date(pushed).toISOString()}; push again, or check why the workflow did not run`;
}

// A head with no check run or status can still have CI on its way. GitHub
// Actions creates its suite before any run, and a fork PR's suite waits for a
// maintainer's approval with no runs at all. Another app may queue a suite on
// every push and never run it, so its queued suite with no runs does not count,
// as in watch-pr/check-suites.ts.
export function suiteBlocker(suites) {
  for (const s of suites) {
    const actions = s.app?.slug === "github-actions";
    const name = actions ? "GitHub Actions" : (s.app?.name ?? s.app?.slug ?? "an app's");
    if (s.status !== "completed") {
      if (!actions && s.status === "queued" && !s.latest_check_runs_count) continue;
      return `the ${name} check suite has not finished; wait for it`;
    }
    if (GREEN.has(s.conclusion)) continue;
    if (s.conclusion === "action_required" && actions) return "GitHub Actions waits for a maintainer's approval to run; approve the workflows on the pull request";
    return `the ${name} check suite concluded ${s.conclusion}`;
  }
  return null;
}

// The gates in force for this PR: the user's file, then the repository's at the base and the head.
function operatorGates(repoGates) {
  const user = userFile();
  const layers = existsSync(user) ? [{ source: user, text: readFileSync(user, "utf8") }] : [];
  return strictest([...layers, ...repoGates].map(({ source, text }) => ({ source, gates: parseGates(text, source) })));
}

function out(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return ["held", "refused", "unconfirmed"].includes(result.kind) ? 1 : 0;
}

function usage(message) {
  process.stderr.write(`${message}\nusage: merge-gate.mjs verdict --repo <owner/repo> --sha <head> --state pass|fail [--description <text>]\n       merge-gate.mjs merge --repo <owner/repo> --pr <number> --sha <verified head> [--author-email <email>] [--ci-wait <minutes>] [--dry-run]\n       merge-gate.mjs cosign --repo <owner/repo> --pr <number> --sha <head> --log <decision log> --evidence <pointer> [--why <text>]\n`);
  return 2;
}

export function main(argv) {
  try {
    return run(argv);
  } catch (error) {
    // A gh failure is never permission to merge.
    const detail = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    return out({ kind: "refused", reasons: [`gh failed: ${detail}`] });
  }
}

function run(argv) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        sha: { type: "string" },
        pr: { type: "string" },
        state: { type: "string" },
        description: { type: "string" },
        "author-email": { type: "string" },
        "dry-run": { type: "boolean" },
        "ci-wait": { type: "string" },
        log: { type: "string" },
        evidence: { type: "string" },
        why: { type: "string" },
      },
    }));
  } catch (error) {
    return usage(error.message);
  }
  const { repo, sha } = values;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return usage("--repo must be owner/repo");
  if (!sha || !SHA.test(sha)) return usage("--sha must be a full 40-character commit SHA");

  if (command === "verdict") {
    const state = { pass: "success", fail: "failure" }[values.state];
    if (!state) return usage("--state must be pass or fail");
    const description = (values.description ?? (state === "success" ? "Verified by an agent that did not write the code" : "Verification failed")).slice(0, 140);
    gh(["api", "--method", "POST", `repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${CONTEXT}`, "-f", `description=${description}`]);
    return out({ kind: "recorded", repo, sha, state });
  }

  if (command === "cosign") {
    if (!/^\d+$/.test(values.pr ?? "")) return usage("--pr must be a number");
    if (!values.log || !values.evidence) return usage("--log and --evidence are required");
    const pr = Number(values.pr);
    const facts = readFacts(repo, pr, sha);
    if (latestByContext(facts.statuses).get(CONTEXT)?.state !== "success") {
      return out({ kind: "refused", repo, pr, sha, reasons: [`no passing ${CONTEXT} on ${sha}: a co-sign checks the verifier's evidence, so the verifier comes first`] });
    }
    const guard = floor({ repo, pr, sha, view: facts.view });
    if (guard.ok) return out({ kind: "refused", repo, pr, sha, reasons: ["the floor passes on this head, so there is nothing to co-sign"] });
    if (!guard.cosign) return out({ kind: "refused", repo, pr, sha, reasons: ["a co-sign clears only changed assertions, moved ones included, and these findings refuse on their own", ...guard.reasons] });
    const n = guard.reasons.length;
    const what = `${n} changed assertion${n === 1 ? "" : "s"}`;
    const row = [LOG, values.log, "cosign", `co-signed ${what} on ${repo}#${pr} at ${sha}`, values.why ?? "the verifier's evidence shows the behavior changed", values.evidence, `${COSIGN} ${guard.cosign}`];
    const logged = spawnSync("bash", row, { encoding: "utf8", timeout: 60_000 });
    if (logged.status !== 0) return out({ kind: "refused", repo, pr, sha, reasons: [`could not write the decision log: ${String(logged.stderr || logged.error || "").trim().split("\n")[0]}`] });
    gh(["api", "--method", "POST", `repos/${repo}/statuses/${sha}`, "-f", "state=success", "-f", `context=${COSIGN}`, "-f", `description=co-signed ${what} ${guard.cosign}`]);
    return out({ kind: "recorded", repo, pr, sha, cosign: guard.cosign });
  }

  if (command === "merge") {
    if (!/^\d+$/.test(values.pr ?? "")) return usage("--pr must be a number");
    const pr = Number(values.pr);
    const facts = readFacts(repo, pr, sha);
    const reasons = refusals(facts, sha);
    if (reasons.length) return out({ kind: "refused", repo, pr, sha, reasons });
    const guard = floor({ repo, pr, sha, view: facts.view, cosigned: cosignOf(facts.statuses) });
    if (guard.cosign) {
      const hint = `a changed or moved assertion needs the root agent's co-sign: it checks the verifier's evidence that the behavior changed and that the new form is no weaker, then runs merge-gate.mjs cosign --repo ${repo} --pr ${pr} --sha ${sha} --log <its decision log> --evidence <where the evidence is>`;
      return out({ kind: "refused", repo, pr, sha, reasons: [...guard.reasons, hint] });
    }
    if (!guard.ok) return out({ kind: "refused", repo, pr, sha, reasons: guard.reasons });
    let gates;
    try {
      gates = operatorGates(guard.repoGates);
    } catch (error) {
      return out({ kind: "refused", repo, pr, sha, reasons: [`operator's gates could not be read: ${error.message}`] });
    }
    const waitMinutes = Number(values["ci-wait"] ?? 10);
    if (!(waitMinutes > 0)) return usage("--ci-wait must be a number of minutes");
    const wfRuns = guard.prWorkflows.length ? pages(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, "workflow_runs") : [];
    const required = requiredChecks(repo, facts.view.baseRefName);
    const blocker = expectedBlocker({ ...guard, wfRuns, required, runs: facts.runs, statuses: facts.statuses, pushed: pushedAt(repo, facts.view, guard.committedAt), now: Date.now(), waitMs: waitMinutes * 60_000 });
    if (blocker) return out({ kind: "refused", repo, pr, sha, reasons: [`no CI result on ${sha}: ${blocker}`] });
    // Failed or pending checks were refused above, so a head here either has
    // green checks or none at all.
    const none = facts.runs.length + facts.statuses.filter((s) => s.context !== CONTEXT && s.context !== COSIGN).length === 0;
    if (none) {
      const suites = pages(`repos/${repo}/commits/${sha}/check-suites?per_page=100`, "check_suites");
      const blocked = suiteBlocker(suites) ?? (guard.workflows && guard.skipsCI ? "its head commit's message asks GitHub to skip CI; push a head without it" : null);
      if (blocked) return out({ kind: "refused", repo, pr, sha, reasons: [`no CI result on ${sha}: ${blocked}`] });
      if (gates.noCI === "wait") {
        return out({ kind: "held", repo, pr, sha, checks: "none", reasons: [`no CI result on ${sha}, and the operator's gates hold such a PR for a person (noCI: wait, from ${gates.from.noCI}); it is merge-ready, so report it and leave the merge to a person`] });
      }
    }
    const checks = none ? { checks: "none" } : {};
    if (values["dry-run"]) return out({ kind: "would-merge", repo, pr, sha, ...checks });
    const author = values["author-email"] ? ["--author-email", values["author-email"]] : [];
    // From here the merge request may have reached GitHub, so a failure is
    // "unconfirmed", never "refused": the PR may already be merged.
    let after;
    try {
      gh(["pr", "merge", String(pr), "--repo", repo, "--squash", "--match-head-commit", sha, ...author]);
      after = ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "state,mergeCommit,headRefOid"]);
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim().split("\n")[0];
      return out({ kind: "unconfirmed", repo, pr, sha, reasons: [`merge requested, then gh failed: ${detail}; read the PR back before anything else`] });
    }
    if (after.state !== "MERGED" || !after.mergeCommit?.oid || after.headRefOid !== sha) {
      return out({ kind: "unconfirmed", repo, pr, sha, reasons: [`merge not confirmed: state ${after.state}, head ${after.headRefOid}`] });
    }
    return out({ kind: "merged", repo, pr, sha, ...checks, mergeCommit: after.mergeCommit.oid });
  }

  return usage(`unknown command ${JSON.stringify(command ?? "")}`);
}

if (process.argv[1]?.endsWith("merge-gate.mjs")) process.exitCode = main(process.argv.slice(2));
