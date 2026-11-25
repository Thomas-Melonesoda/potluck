#!/usr/bin/env node
// potluck: the standard live run. Free preflight first; a paid `claude -p`
// only when every check passes and the caller passes --confirm-paid.
//
//   node tools/live-run.mjs --max-budget-usd <amount> --prompt <text> [options]
//
//   --confirm-paid           run the paid step, which needs the owner's direct word for
//                            this run first; without it the command is only printed
//   --cwd <dir>              where claude runs (default: here)
//   --setting-sources <list> default "project", so only the change under test brings
//                            settings, hooks and permission rules
//   --keep-user-endpoint     pass the ANTHROPIC_ values of the user's settings to
//                            claude when --setting-sources leaves them out
// --plugin-dir, --model, --allowedTools, --disallowedTools, --permission-mode,
// --output-format, --strict-mcp-config, --verbose and --no-session-persistence go to
// claude as given. No other flag does, so none can change what the preflight checked.
//
// The preflight, which sends no model request:
//   claude    it is on PATH and has `auth status`
//   settings  --setting-sources does not drop the user's endpoint and model mapping
//             (settings env ANTHROPIC_*), and neither the project's settings nor the
//             shell sends the run to an endpoint the free check cannot see
//   login     claude has a login or token with the paid step's settings sources,
//             environment and folder, which does not show the server accepts it
//   endpoint  the API address claude reads is the one the settings give, and takes a
//             direct TCP connection, so a machine that needs a proxy fails here
//
// The checks print setting names and claude's version number, never a value.
// The printed command and the paid output hide the values the script knows:
// secret-looking values and API or proxy addresses (with host and hostname) from the
// environment and the settings read here, and the home and work folders. A person must
// read both before they go in a public PR. Not hidden: a resolved IP, a user name, bare
// IPv6, a proxy password printed alone, secrets under 8 characters or under a plain
// name, a symlinked home's real path, a file's text, or anything else it does not know.
// The budget is checked after a call, so a run can end slightly over the cap.
// Exit 0 when the preflight passes, 1 when it fails, 2 on a usage error, and claude's
// own status after a paid step.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = (message) => {
  process.stderr.write(`tools/live-run.mjs: ${message}\nusage: node tools/live-run.mjs --max-budget-usd <amount> --prompt <text> [--confirm-paid] [options]\nPaid output hides only the values this script knows; a person must read it before it goes in a public PR.\n`);
  process.exit(2);
};

const text = { type: "string" }, flag = { type: "boolean" };
const PASSED = {
  "plugin-dir": { ...text, multiple: true },
  model: text, allowedTools: text, disallowedTools: text, "permission-mode": text, "output-format": text,
  "strict-mcp-config": flag, verbose: flag, "no-session-persistence": flag,
};
const OWN = {
  "max-budget-usd": text, prompt: text, "keep-user-endpoint": flag, "confirm-paid": flag,
  cwd: { ...text, default: "." }, "setting-sources": { ...text, default: "project" },
};

// Node's own error report can quote a value, such as one that holds a null byte.
process.on("uncaughtException", (error) => (console.error(`tools/live-run.mjs: stopped on an unexpected error (${error.code ?? "no code"})`), process.exit(1)));
let opts, cwd;
try {
  opts = parseArgs({ options: { ...PASSED, ...OWN } }).values;
} catch (error) {
  usage(`the arguments are not valid (${error.code})`);
}
const budget = opts["max-budget-usd"];
if (!/^\d+(\.\d+)?$/.test(budget ?? "") || !(Number(budget) > 0)) usage("--max-budget-usd must be given, as a dollar amount above 0");
if (!opts.prompt?.trim()) usage("--prompt must be given");
const sources = opts["setting-sources"].split(",");
if (sources.some((s) => !["user", "project", "local"].includes(s))) usage("--setting-sources takes user, project and local, comma-separated");
try {
  cwd = realpathSync(opts.cwd);
  readdirSync(cwd);
} catch {
  usage("--cwd is not a folder that can be read");
}

let failed = false;
const report = (ok, name, detail) => {
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(8)}  ${detail}`);
};

// A parse error can quote the text, so it is not kept.
function json(read) {
  try {
    return JSON.parse(read());
  } catch {
    return null;
  }
}

// The env block of a settings file, or a failed check.
function settingsEnv(whose, file) {
  const settings = existsSync(file) ? json(() => readFileSync(file, "utf8")) : {};
  if (!settings) report(false, "settings", `the ${whose} settings file is not valid JSON or cannot be read, so the endpoint it gives is unknown`);
  return settings?.env ?? {};
}
const named = (env, pattern) => Object.keys(env).filter((key) => pattern.test(key)).sort();
const DEFAULT = "https://api.anthropic.com";
const ENDPOINT = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/;

function address(text) {
  const url = URL.canParse(text) ? new URL(text) : null;
  return url && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search ? url : null;
}

const accepts = ({ protocol, hostname, port }) =>
  new Promise((done) => {
    const socket = connect({ host: hostname.replace(/^\[|\]$/g, ""), port: Number(port) || (protocol === "https:" ? 443 : 80) });
    const end = (ok) => (socket.destroy(), done(ok));
    socket.setTimeout(5000, () => end(false)).once("connect", () => end(true)).once("error", () => end(false));
  });

const user = settingsEnv("user", join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"));
const project = sources.includes("project") ? settingsEnv("project", join(cwd, ".claude/settings.json")) : {};
const local = sources.includes("local") ? settingsEnv("local", join(cwd, ".claude/settings.local.json")) : {};
const kept = opts["keep-user-endpoint"] ? Object.fromEntries(named(user, /^ANTHROPIC_/).map((key) => [key, String(user[key])])) : {};
const env = { ...process.env, ...kept };

const hidden = [process.env, user, project, local].flatMap(Object.entries).flatMap(([key, value]) => {
  const raw = String(value).trim();
  if (/TOKEN|KEY|SECRET|PASSWORD|HEADERS/i.test(key)) return [raw, ...raw.split(/\s+/)].filter((part) => part.length >= 8);
  if (!/^ANTHROPIC_.*URL$|_PROXY$/i.test(key) || /(^|_)NO_PROXY$/i.test(key)) return [];
  const full = /^[^/]*:\/\/|^https?:/i.test(raw) ? raw : `http://${raw}`;
  const { host, hostname } = URL.canParse(full) ? new URL(full) : { host: "", hostname: "" };
  return [raw.replace(/\/+$/, ""), host, hostname];
});
// claude names its per-project folders after the path, with dashes.
for (const path of [homedir(), cwd, resolve(opts.cwd)]) if (path !== "/") hidden.push(path, path.replace(/[^a-zA-Z0-9]/g, "-"));
hidden.sort((a, b) => b.length - a.length);
const redact = (text) => hidden.reduce((t, value) => (value ? t.replaceAll(value, "[redacted]") : t), text ?? "");

const claude = (args, extra = {}) => spawnSync("claude", args, { cwd, env, encoding: "utf8", input: "", maxBuffer: 1 << 30, ...extra });
const free = (args) => claude(args, { timeout: 30_000 });

async function preflight() {
  const version = free(["--version"]);
  if (version.error || version.status !== 0) return report(false, "claude", "claude is not on PATH or did not start");
  // Without the subcommand the words `auth status` would be a prompt, so a paid call.
  if (!/\bauth status\b/.test(free(["auth", "status", "--help"]).stdout ?? "")) return report(false, "claude", "this claude has no `auth status` command");
  report(true, "claude", /^\d+\.\d+\.\d+(?!\S)/.exec(version.stdout)?.[0] ?? "it printed no plain version number");

  const dropped = sources.includes("user") ? [] : named(user, /^ANTHROPIC_/);
  if (dropped.length) report(opts["keep-user-endpoint"], "settings", `--setting-sources ${sources.join()} skips the user's ${dropped.join(", ")}; ${opts["keep-user-endpoint"] ? "--keep-user-endpoint passes them in the environment" : "add --keep-user-endpoint to pass them, or user to --setting-sources"}`);
  for (const [source, set] of Object.entries({ project, local })) {
    const names = named(set, ENDPOINT);
    if (names.length) report(false, "settings", `the ${source} settings set ${names.join(", ")}, and the free check cannot see whether claude applies them`);
  }
  const cloud = named({ ...env, ...(sources.includes("user") ? user : {}) }, /^CLAUDE_CODE_USE_/);
  if (cloud.length) report(false, "settings", `${cloud.join(", ")} sends the run to a cloud provider, which this script does not check`);
  if (!failed && !dropped.length) report(true, "settings", "--setting-sources skips no endpoint settings");

  const auth = (form) => free([`--setting-sources=${sources.join()}`, "auth", "status", form]).stdout ?? "";
  const loggedIn = json(() => auth("--json"))?.loggedIn === true;
  report(loggedIn, "login", loggedIn ? "logged in" : "claude is not logged in as this run would see it; one started from a sandboxed tool may not see the login, so run this in your own terminal");

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
  console.log(`would run (paid, capped at $${budget}): claude ${redact(quoted)} (the prompt, ${opts.prompt.length} characters, on stdin)`);
  console.log("Not run. Spending money needs the owner's direct word for this run; after it, add --confirm-paid.");
  process.exit(0);
}

const run = claude(args, { input: opts.prompt });
process.stdout.write(redact(run.stdout));
process.stderr.write(redact(run.stderr));
if (run.error) console.error(`claude did not finish: ${run.error.code ?? "error"}`);
process.exitCode = run.status ?? 1;
