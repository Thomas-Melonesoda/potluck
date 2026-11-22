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
// It merges with `gh pr merge --squash --match-head-commit <sha>`, never
// `--auto`, so GitHub itself refuses if the head moves after the checks, and
// it reads the PR back to confirm the merge.
//
// Output is one JSON line: { kind: "merged" | "would-merge" | "refused" |
// "unconfirmed" | "recorded", ... }. "unconfirmed" means the merge was
// requested but not read back as merged, so it may have landed. Exit 0 on
// merged, would-merge, or recorded; 1 on refused or unconfirmed; 2 on a usage
// error.

import { execFileSync } from "node:child_process";
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
    "--json", "state,isDraft,headRefOid,mergeable,baseRefName",
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
    const reasons = refusals(readFacts(repo, pr, sha), sha);
    if (reasons.length) return out({ kind: "refused", repo, pr, sha, reasons });
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
