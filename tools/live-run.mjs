#!/usr/bin/env node
// potluck: the standard live run. Free preflight first; a paid `claude -p`
// only when every check passes and the caller passes --confirm-paid.
//
//   node tools/live-run.mjs --max-budget-usd <amount> --prompt <text> [options]
//
//   --confirm-paid           run the paid step; without it the preflight runs
//                            and the command is printed. Spending money needs
//                            the owner's direct word for this run first.
//   --cwd <dir>              where claude runs (default: here)
//   --setting-sources <list> default "project", so only the change under test
//                            brings settings, hooks and permission rules
//   --keep-user-endpoint     pass the ANTHROPIC_ values of the user's settings
//                            to claude when --setting-sources leaves them out
//   --plugin-dir, --model, --allowedTools, --disallowedTools,
//   --permission-mode, --output-format, --strict-mcp-config, --verbose,
//   --no-session-persistence go to claude as given. No other flag does, so
//                            none can change what the preflight checked.
//
// The preflight, which sends no model request:
//   claude    it is on PATH and has `auth status`
//   settings  --setting-sources does not drop the user's endpoint and model
//             mapping (settings env ANTHROPIC_*), and neither the project's
//             settings nor the shell sends the run to an endpoint the free
//             check cannot see
//   login     claude is logged in with the same settings sources, environment
//             and folder as the paid step. This shows a login or token is
//             there, not that the server accepts it.
//   endpoint  the API address claude reads is the one the settings give, and
//             it accepts a TCP connection. The connection is direct, so a
//             machine that reaches the API only through a proxy fails here.
//
// Output names settings but never prints a value, an API address included, so
// it can go in a PR. What the paid step prints has known tokens redacted. The
// budget is checked after a call, so a run can end slightly over the cap.
// Exit 0 when the preflight passes, 1 when it fails, 2 on a usage error, and
// claude's own status after a paid step.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = (message) => {
  process.stderr.write(`tools/live-run.mjs: ${message}\nusage: node tools/live-run.mjs --max-budget-usd <amount> --prompt <text> [--confirm-paid] [options]\n`);
  process.exit(2);
};

const PASSED = {
  "plugin-dir": { type: "string", multiple: true },
  model: { type: "string" },
  allowedTools: { type: "string" },
  disallowedTools: { type: "string" },
  "permission-mode": { type: "string" },
  "output-format": { type: "string" },
  "strict-mcp-config": { type: "boolean" },
  verbose: { type: "boolean" },
  "no-session-persistence": { type: "boolean" },
};

function parse() {
  try {
    return parseArgs({
      options: {
        ...PASSED,
        "max-budget-usd": { type: "string" },
        prompt: { type: "string" },
        cwd: { type: "string", default: "." },
        "setting-sources": { type: "string", default: "project" },
        "keep-user-endpoint": { type: "boolean", default: false },
        "confirm-paid": { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    return usage(error.message.split("\n")[0]);
  }
}

const opts = parse();
const budget = opts["max-budget-usd"];
if (!/^\d+(\.\d+)?$/.test(budget ?? "") || !(Number(budget) > 0)) usage("--max-budget-usd must be given, as a dollar amount above 0");
if (!opts.prompt?.trim()) usage("--prompt must be given");
const sources = opts["setting-sources"].split(",");
if (sources.some((s) => !["user", "project", "local"].includes(s))) usage("--setting-sources takes user, project and local, comma-separated");
const cwd = resolve(opts.cwd);
if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) usage(`--cwd ${opts.cwd} is not a folder`);

let failed = false;
const report = (ok, name, detail) => {
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(8)}  ${detail}`);
};

// A parse error can quote the text, so it is not kept.
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The env block of a settings file, or a failed check.
function settingsEnv(whose, file) {
  if (!existsSync(file)) return {};
  const settings = json(readFileSync(file, "utf8"));
  if (!settings) report(false, "settings", `the ${whose} settings file is not valid JSON, so the endpoint it gives is unknown`);
  return settings?.env ?? {};
}
const named = (env, pattern) => Object.keys(env).filter((key) => pattern.test(key)).sort();
const DEFAULT = "https://api.anthropic.com";
const ENDPOINT = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/;

function address(text) {
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search ? url : null;
  } catch {
    return null;
  }
}

const accepts = ({ protocol, hostname, port }) =>
  new Promise((done) => {
    const socket = connect({ host: hostname.replace(/^\[|\]$/g, ""), port: Number(port) || (protocol === "https:" ? 443 : 80) });
    const end = (ok) => (socket.destroy(), done(ok));
    socket.setTimeout(5000, () => end(false)).once("connect", () => end(true)).once("error", () => end(false));
  });

const user = settingsEnv("user", join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"));
const kept = opts["keep-user-endpoint"] ? Object.fromEntries(named(user, /^ANTHROPIC_/).map((key) => [key, String(user[key])])) : {};
const env = { ...process.env, ...kept };
const claude = (args, extra = {}) => spawnSync("claude", args, { cwd, env, encoding: "utf8", input: "", maxBuffer: 1 << 30, ...extra });
const free = (args) => claude(args, { timeout: 30_000 });

async function preflight() {
  const version = free(["--version"]);
  if (version.error || version.status !== 0) return report(false, "claude", "claude is not on PATH or did not start");
  // Without the subcommand the words `auth status` would be a prompt, so a paid call.
  if (!/\bauth status\b/.test(free(["auth", "status", "--help"]).stdout ?? "")) return report(false, "claude", "this claude has no `auth status` command");
  report(true, "claude", version.stdout.trim());

  const dropped = sources.includes("user") ? [] : named(user, /^ANTHROPIC_/);
  if (dropped.length) report(opts["keep-user-endpoint"], "settings", `--setting-sources ${sources.join()} skips the user's ${dropped.join(", ")}; ${opts["keep-user-endpoint"] ? "--keep-user-endpoint passes them in the environment" : "add --keep-user-endpoint to pass them, or user to --setting-sources"}`);
  for (const [source, file] of [["project", "settings.json"], ["local", "settings.local.json"]]) {
    const names = sources.includes(source) ? named(settingsEnv(source, join(cwd, ".claude", file)), ENDPOINT) : [];
    if (names.length) report(false, "settings", `the ${source} settings set ${names.join(", ")}, and the free check cannot see whether claude applies them`);
  }
  const cloud = named({ ...env, ...(sources.includes("user") ? user : {}) }, /^CLAUDE_CODE_USE_/);
  if (cloud.length) report(false, "settings", `${cloud.join(", ")} sends the run to a cloud provider, which this script does not check`);
  if (!failed && !dropped.length) report(true, "settings", "--setting-sources skips no endpoint settings");

  const auth = (form) => free([`--setting-sources=${sources.join()}`, "auth", "status", form]).stdout ?? "";
  const login = json(auth("--json"));
  const loggedIn = login?.loggedIn === true;
  report(loggedIn, "login", loggedIn ? `logged in (${/^\w+$/.exec(login.authMethod)?.[0] ?? "unknown method"})` : "claude is not logged in as this run would see it; one started from a sandboxed tool may not see the login, so run this in your own terminal");

  const fromUser = (sources.includes("user") || opts["keep-user-endpoint"]) && user.ANTHROPIC_BASE_URL;
  const whose = fromUser ? "the address in the user's settings" : env.ANTHROPIC_BASE_URL ? "the address in the shell's ANTHROPIC_BASE_URL" : "the default API address";
  const want = address(fromUser || env.ANTHROPIC_BASE_URL || DEFAULT);
  const got = address(/^Anthropic base URL: (\S+)\s*$/m.exec(auth("--text"))?.[1] ?? DEFAULT);
  if (!want || !got) return report(false, "endpoint", `${whose} is not an http or https URL free of credentials and query`);
  if (want.href !== got.href) return report(false, "endpoint", `claude does not read ${whose}`);
  const open = await accepts(got);
  report(open, "endpoint", `claude reads ${whose}, which ${open ? "accepts" : "does not accept"} a connection`);
}

await preflight();
if (failed) {
  console.log("Preflight failed. The paid step did not run.");
  process.exit(1);
}

const args = ["-p", `--setting-sources=${sources.join()}`, `--max-budget-usd=${budget}`];
for (const name of Object.keys(PASSED)) for (const value of [opts[name] ?? []].flat()) args.push(value === true ? `--${name}` : `--${name}=${value}`);
const quoted = args.map((a) => (/^[\w./=,:@-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
if (!opts["confirm-paid"]) {
  console.log(`would run (paid, capped at $${budget}): claude ${quoted} (the prompt, ${opts.prompt.length} characters, on stdin)`);
  console.log("Not run. Spending money needs the owner's direct word for this run; after it, add --confirm-paid.");
  process.exit(0);
}

const run = claude(args, { input: opts.prompt });
const secrets = [...Object.entries(env), ...Object.entries(user)]
  .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD|HEADERS/i.test(key))
  .flatMap(([, value]) => String(value).split(/\s+/))
  .filter((part) => part.length >= 8)
  .sort((a, b) => b.length - a.length);
const redact = (text) => secrets.reduce((t, secret) => t.replaceAll(secret, "[redacted]"), text ?? "");
process.stdout.write(redact(run.stdout));
process.stderr.write(redact(run.stderr));
if (run.error) console.error(`claude did not finish: ${run.error.code ?? "error"}`);
process.exitCode = run.status ?? 1;
