#!/usr/bin/env node
// potluck: the quality floor and the overview check for one change, run by CI
// on every pull request (design rows D5, A8, R2 and R4).
//
//   node floor.mjs --base <rev> [--head <rev>] [--cosign <fingerprint>[,<fingerprint>...]]
//
// Run it from a checkout that holds both commits. It checks out the head in a
// throwaway tree that borrows the checkout's objects and none of its config,
// with attributes read from the base, so the change's own .gitattributes can
// neither re-encode a file nor hide a diff. There it runs Addy Osmani's floor
// guard (the one js block in constraint-driven-development's floor-guard.md)
// against the base, then grill's overview.mjs --check. The floor refuses a
// change that lowers the bar: a weakened CONSTRAINTS.md, a test made easier, a
// new suppression comment, a stub or empty catch, a new exception row. A guard
// that cannot run refuses too.
//
// A changed or moved assertion is the one finding that can pass: when every
// finding is one, the result names a fingerprint of them, and the root agent
// co-signs it by posting `potluck-cosign: <head sha> <fingerprint>` on the PR
// after checking the verifier's evidence. CI passes each fingerprint co-signed
// for the head to --cosign, so a new head or different findings need a new
// co-sign.
//
// Output is one JSON line: { kind: "pass" | "fail", reasons, cosign? }.
// Exit 0 on pass, 1 on fail, 2 on a usage error.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLOOR_GUARD = join(HERE, "../../constraint-driven-development/references/floor-guard.md");
export const OVERVIEW = join(HERE, "../../grill/scripts/overview.mjs");

// The guard's code is the one fenced js block in floor-guard.md, so a sync of
// Addy's skill updates the guard and nothing here copies it.
export function guardSource(path = FLOOR_GUARD) {
  const text = readFileSync(path, "utf8");
  const blocks = [...text.matchAll(/^```js\n([\s\S]*?)^```$/gm)];
  if (blocks.length !== 1) throw new Error(`${path} has ${blocks.length} js blocks, expected one`);
  return blocks[0][1];
}

// The only findings a co-sign clears. Every other finding fails outright.
const COSIGNABLE = /^\[assertion-(changed|moved)\] /;
const fingerprint = (findings) => createHash("sha256").update([...findings].sort().join("\n")).digest("hex").slice(0, 16);

// Formats that are binary by nature. Any other changed file must diff as text.
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|heic|pdf|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|flac|mov|webm|avi|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|so|dylib|dll|exe|class|pyc|o|a|lib|sqlite3?|db|lockb|docx?|xlsx?|pptx?|keynote|sketch|fig)$/i;

const gitIn = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity, timeout: 300_000 });

// The project overview must match the sources grill writes, and no Done when
// item may be ticked without its proof. A project with none of those sources
// needs no overview and passes.
function overviewCheck(tree, env) {
  const run = spawnSync(process.execPath, [OVERVIEW, "--root", tree, "--check"], { cwd: tree, env, encoding: "utf8", timeout: 120_000 });
  if (run.status === 0) return { ok: true, reasons: [] };
  const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  if (run.status === 1) return { ok: false, reasons: lines.map((l) => `overview: ${l}`) };
  return { ok: false, reasons: [`overview check could not run: ${lines[0] ?? `exit ${run.status ?? run.signal}`}`] };
}

// Runs the floor guard and the overview check on `head` against `base`.
// Returns { ok, reasons } plus `cosign`, the findings' fingerprint, when a
// co-sign could clear them all.
export function floor({ base, head = "HEAD", cosigned = [], cwd = process.cwd() }) {
  let top, source;
  try {
    top = gitIn(cwd, ["rev-parse", "--show-toplevel"]).trim();
    source = guardSource();
  } catch (error) {
    return { ok: false, reasons: [`floor guard could not run: ${String(error?.stderr || error?.message || error).trim().split("\n")[0]}`] };
  }
  const scratch = mkdtempSync(join(tmpdir(), "potluck-floor-"));
  const tree = join(scratch, "tree");
  // Renames are off by default, and the guard asks for them only where a test
  // file kept a name its runner reads; colour and path quoting are off, so the
  // guard reads plain names. Variables that would point git elsewhere or swap
  // its diff are dropped, and global and system config are off.
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
    const baseSha = gitIn(top, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
    const headSha = gitIn(top, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
    // A fresh repository that borrows the checkout's objects through
    // alternates, plus its shallow boundary.
    execFileSync("git", ["init", "--quiet", tree], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    const objects = join(gitIn(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), "objects");
    writeFileSync(join(tree, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const shallow = gitIn(top, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]).trim();
    if (existsSync(shallow)) copyFileSync(shallow, join(tree, ".git", "shallow"));
    attrs = { GIT_ATTR_SOURCE: baseSha };
    isolated(["checkout", "--quiet", "--detach", headSha]);
    // The guard reads text diffs only, so any changed file git sees as binary
    // (one NUL byte is enough) would hide every finding in it. Only known
    // binary formats may be binary, and a deleted file hides nothing.
    const numstat = isolated(["diff", "--numstat", "-z", baseSha, "HEAD"]).split("\0").filter(Boolean);
    const present = new Set(isolated(["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean));
    const opaque = numstat.filter((l) => /^-\t-\t/.test(l)).map((l) => l.slice(4)).filter((f) => present.has(f) && !BINARY.test(f));
    if (opaque.length) return { ok: false, reasons: opaque.map((f) => `floor: [binary-source] ${f}: git reads this file as binary, so the floor cannot check it; remove the NUL or control bytes, or use a binary format's usual extension`) };
    const script = join(scratch, "floor-guard.mjs");
    writeFileSync(script, source);
    const run = spawnSync(process.execPath, [script, "--base", baseSha], { cwd: tree, env: { ...env, ...attrs }, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (run.status === 0) return overviewCheck(tree, env);
    if (run.status === 1) {
      const findings = lines.map((l) => l.trim()).filter((l) => /^\[[a-z-]+\] /.test(l));
      const cosign = findings.length && findings.every((f) => COSIGNABLE.test(f)) ? fingerprint(findings) : null;
      if (cosign && cosigned.includes(cosign)) return overviewCheck(tree, env);
      const reasons = (findings.length ? findings : lines).map((l) => `floor: ${l.trim()}`);
      if (!cosign) return { ok: false, reasons };
      const hint = `a changed or moved assertion needs the root agent's co-sign: it checks the verifier's evidence that the behavior changed and that the new form is no weaker, then comments \`potluck-cosign: ${headSha} ${cosign}\` on the PR and reruns this check`;
      return { ok: false, cosign, reasons: [...reasons, hint] };
    }
    return { ok: false, reasons: [`floor guard could not run: ${lines[0] ?? `exit ${run.status ?? run.signal}`}`] };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    return { ok: false, reasons: [`floor guard could not run: ${detail}`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { base: { type: "string" }, head: { type: "string" }, cosign: { type: "string" } } }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (!values.base) {
    process.stderr.write("usage: floor.mjs --base <rev> [--head <rev>] [--cosign <fingerprint>[,<fingerprint>...]]\n");
    return 2;
  }
  const cosigned = (values.cosign ?? "").split(/[\s,]+/).filter((f) => /^[0-9a-f]{16}$/.test(f));
  const { ok, reasons, cosign } = floor({ base: values.base, head: values.head, cosigned });
  process.stdout.write(`${JSON.stringify({ kind: ok ? "pass" : "fail", reasons, ...(cosign ? { cosign } : {}) })}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("floor.mjs")) process.exitCode = main(process.argv.slice(2));
