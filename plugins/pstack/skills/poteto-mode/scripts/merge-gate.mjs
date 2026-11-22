#!/usr/bin/env node
// potluck: the deterministic merge gate (design row A8).
//
//   node merge-gate.mjs verdict --repo <owner/repo> --sha <head> --state pass|fail [--description <text>]
//   node merge-gate.mjs merge --repo <owner/repo> --pr <number> --sha <verified head> [--author-email <email>] [--dry-run]
//
// `verdict` records a verifier's result as the `potluck/verdict` commit status
// on that exact head, so the result is a fact GitHub holds, not a comment.
//
// `merge` only checks facts, then merges. It refuses unless every one holds:
//   - the PR is open, not a draft, not conflicting, and its head is the
//     verified SHA
//   - that head carries a `potluck/verdict` status of success
//   - every other check run and commit status on that head finished green
//     (a head with no CI passes this one)
//   - the quality floor passes on that head (design rows D5 and A8): Addy
//     Osmani's floor guard, taken unchanged from the synced
//     constraint-driven-development skill, runs in a throwaway clone of the
//     verified head (sharing the checkout's objects, none of its config)
//     against the PR's base. It refuses a change that lowers the
//     bar: a weakened CONSTRAINTS.md, a test made easier, a new suppression
//     comment, a stub or empty catch, a new exception row. Findings in Markdown
//     other than CONSTRAINTS.md are dropped, since docs only describe these
//     moves. A guard that cannot run refuses too. Run the gate from a checkout
//     whose origin is the repo.
// It merges with `gh pr merge --squash --match-head-commit <sha>`, never
// `--auto`, so GitHub itself refuses if the head moves after the checks, and
// it reads the PR back to confirm the merge.
//
// Output is one JSON line: { kind: "merged" | "would-merge" | "refused" |
// "unconfirmed" | "recorded", ... }. "unconfirmed" means the merge was
// requested but not read back as merged, so it may have landed. Exit 0 on
// merged, would-merge, or recorded; 1 on refused or unconfirmed; 2 on a usage
// error.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const CONTEXT = "potluck/verdict";
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
    "--json", "state,isDraft,headRefOid,mergeable,baseRefName,baseRefOid",
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
    if (context === CONTEXT) continue;
    if (s.state === "pending") reasons.push(`status ${context} is still pending`);
    else if (s.state !== "success") reasons.push(`status ${context} is ${s.state}`);
  }
  for (const run of runs) {
    if (run.status !== "completed") reasons.push(`check ${run.name} is still ${run.status}`);
    else if (!GREEN.has(run.conclusion)) reasons.push(`check ${run.name} concluded ${run.conclusion}`);
  }
  return reasons;
}

export const FLOOR_GUARD = join(dirname(fileURLToPath(import.meta.url)), "../../constraint-driven-development/references/floor-guard.md");

// The guard's code is the one fenced js block in floor-guard.md, so a sync of
// Addy's skill updates the guard and nothing here copies it.
export function guardSource(path = FLOOR_GUARD) {
  const text = readFileSync(path, "utf8");
  const blocks = [...text.matchAll(/^```js\n([\s\S]*?)^```$/gm)];
  if (blocks.length !== 1) throw new Error(`${path} has ${blocks.length} js blocks, expected one`);
  return blocks[0][1];
}

const gitIn = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity, timeout: 300_000 });

// Runs the floor guard on the verified head. Returns { ok, reasons }.
export function floor({ repo, pr, sha, view, cwd = process.cwd() }) {
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
  // mark files -diff or binary; renames are off, so a renamed test file shows
  // as deleted; colour and path quoting are off, so the guard reads plain names.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "diff.renames", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "color.ui", GIT_CONFIG_VALUE_1: "never",
    GIT_CONFIG_KEY_2: "color.diff", GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "core.quotePath", GIT_CONFIG_VALUE_3: "false",
  };
  const isolated = (args) => execFileSync("git", ["-C", tree, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity, timeout: 300_000 });
  try {
    gitIn(top, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `refs/pull/${pr}/head`, `refs/heads/${view.baseRefName}`]);
    gitIn(top, ["cat-file", "-e", `${sha}^{commit}`]);
    const base = view.baseRefOid && /^[0-9a-f]{40}$/.test(view.baseRefOid) ? view.baseRefOid : null;
    if (!base) return { ok: false, reasons: ["floor guard could not run: GitHub gave no base commit for the PR"] };
    gitIn(top, ["cat-file", "-e", `${base}^{commit}`]);
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", top, tree], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
    isolated(["checkout", "--quiet", "--detach", sha]);
    const changed = isolated(["diff", "--name-only", "-z", base, "HEAD"]).split("\0").filter(Boolean);
    const script = join(scratch, "floor-guard.mjs");
    writeFileSync(script, source);
    const run = spawnSync(process.execPath, [script, "--base", base], { cwd: tree, env: { ...env, GIT_ATTR_SOURCE: base }, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (run.status === 0) return { ok: true, reasons: [] };
    if (run.status === 1) {
      // The guard reads every file. Markdown other than CONSTRAINTS.md only
      // describes these moves and cannot silence a checker, so its findings
      // are dropped (the owner's ruling, 2026-11-22); a change to
      // CONSTRAINTS.md still counts. A finding names its file before ": ";
      // it is matched against the changed paths, longest first, so a colon
      // or space in a name cannot shift the cut, and a finding whose file is
      // not a changed path is kept.
      const findings = lines.filter((l) => /^\[[a-z-]+\] /.test(l.trim()));
      const byLength = [...changed].sort((a, b) => b.length - a.length);
      const kept = findings.filter((l) => {
        const rest = l.trim().replace(/^\[[a-z-]+\] /, "");
        const file = byLength.find((p) => rest.startsWith(`${p}: `) || rest.startsWith(`${p}\t: `));
        if (file === undefined) return true;
        return !/\.(md|markdown)$/i.test(file) || /(^|\/)CONSTRAINTS\.md$/.test(file);
      });
      if (findings.length && !kept.length) return { ok: true, reasons: [] };
      return { ok: false, reasons: (kept.length ? kept : lines).map((l) => `floor: ${l.trim()}`) };
    }
    return { ok: false, reasons: [`floor guard could not run: ${lines[0] ?? `exit ${run.status ?? run.signal}`}`] };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    return { ok: false, reasons: [`floor guard could not run: ${detail}`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function out(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.kind === "refused" || result.kind === "unconfirmed" ? 1 : 0;
}

function usage(message) {
  process.stderr.write(`${message}\nusage: merge-gate.mjs verdict --repo <owner/repo> --sha <head> --state pass|fail [--description <text>]\n       merge-gate.mjs merge --repo <owner/repo> --pr <number> --sha <verified head> [--author-email <email>] [--dry-run]\n`);
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

  if (command === "merge") {
    if (!/^\d+$/.test(values.pr ?? "")) return usage("--pr must be a number");
    const pr = Number(values.pr);
    const facts = readFacts(repo, pr, sha);
    const reasons = refusals(facts, sha);
    if (reasons.length) return out({ kind: "refused", repo, pr, sha, reasons });
    const guard = floor({ repo, pr, sha, view: facts.view });
    if (!guard.ok) return out({ kind: "refused", repo, pr, sha, reasons: guard.reasons });
    if (values["dry-run"]) return out({ kind: "would-merge", repo, pr, sha });
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
    return out({ kind: "merged", repo, pr, sha, mergeCommit: after.mergeCommit.oid });
  }

  return usage(`unknown command ${JSON.stringify(command ?? "")}`);
}

if (process.argv[1]?.endsWith("merge-gate.mjs")) process.exitCode = main(process.argv.slice(2));
