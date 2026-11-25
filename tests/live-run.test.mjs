// potluck: the standard live run, tools/live-run.mjs, against a fake `claude`.
// No test makes a paid call: the fake only records how it was called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../tools/live-run.mjs");
const node = Bun.which("node");
const TOKEN = "fixture-token";

// Reads its settings the way claude 2.1.311 does: the user's env over the
// shell's, and only when --setting-sources keeps the user's file. A project's
// env does not show in `auth status`.
const FAKE = `#!${node}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2), line = args.join(" "), say = (s) => process.stdout.write(s + "\\n");
fs.appendFileSync(process.env.FAKE_LOG, line + "\\n");
const sources = args.find((a) => a.startsWith("--setting-sources="))?.slice(18) ?? "user,project,local";
let user = {};
const file = path.join(process.env.HOME, ".claude/settings.json");
if (sources.split(",").includes("user") && fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, "utf8")).env;
const env = { ...process.env, ...user };
if (line === "--version") say("9.9.9 (Claude Code) " + process.env.FAKE_VERSION);
else if (line === "auth status --help") say(process.env.FAKE_OLD ? "Usage: claude [prompt]" : "Usage: claude auth status [options]");
else if (line.endsWith("auth status --json")) {
  say(JSON.stringify({ loggedIn: Boolean(env.ANTHROPIC_AUTH_TOKEN), authMethod: env.ANTHROPIC_AUTH_TOKEN ? "oauth_token" : "none", email: "someone@example.invalid" }));
  process.exit(env.ANTHROPIC_AUTH_TOKEN ? 0 : 1);
} else if (line.endsWith("auth status --text")) {
  const url = process.env.FAKE_URL ?? env.ANTHROPIC_BASE_URL;
  if (url) say("Anthropic base URL: " + url);
} else if (args[0] === "-p") {
  say("PAID prompt=" + fs.readFileSync(0, "utf8") + " token=" + env.ANTHROPIC_AUTH_TOKEN + " model=" + env.ANTHROPIC_MODEL + " " + env.ANTHROPIC_CUSTOM_HEADERS + " " + process.env.FAKE_SAY);
  for (const p of [process.cwd(), process.env.HOME]) say(p + " " + p.replace(/[^a-zA-Z0-9]/g, "-"));
  process.stderr.write("err " + env.ANTHROPIC_AUTH_TOKEN);
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
} else process.exit(9);
`;

const root = mkdtempSync(join(tmpdir(), "potluck-live-run-"));
const listening = createServer();
let up, down;
beforeAll(async () => {
  const listen = (s) => new Promise((done) => s.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${s.address().port}`)));
  up = await listen(listening);
  const closed = createServer();
  down = await listen(closed);
  await new Promise((done) => closed.close(done));
});
afterAll(() => {
  listening.close();
  rmSync(root, { recursive: true, force: true });
});

const ARGS = ["--max-budget-usd", "0.20", "--prompt", "say hi"];
let n = 0;
function live(args, { user, project, local, shell = {}, claude = true } = {}) {
  const dir = join(root, String(++n)), home = join(dir, "home"), cwd = join(dir, "work"), bin = join(dir, "bin"), log = join(dir, "calls");
  for (const d of [join(home, ".claude"), join(cwd, ".claude"), bin]) mkdirSync(d, { recursive: true });
  if (claude) writeFileSync(join(bin, "claude"), FAKE, { mode: 0o755 });
  if (user !== undefined) writeFileSync(join(home, ".claude/settings.json"), typeof user === "string" ? user : JSON.stringify({ env: user }));
  for (const [file, set] of Object.entries({ settings: project, "settings.local": local })) if (set) writeFileSync(join(cwd, `.claude/${file}.json`), JSON.stringify({ env: set }));
  const r = spawnSync(node, [script, ...args], { cwd, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_LOG: log, ...shell } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: r.status, out: r.stdout + r.stderr, calls, paid: calls.filter((c) => !/^--version$|auth status/.test(c)) };
}
const good = () => ({ shell: { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: up } });
const settings = () => ({ ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: up, ANTHROPIC_MODEL: "mapped" });

describe("the paid step", () => {
  test("does not run by default: the preflight passes and the command is printed", () => {
    const r = live([...ARGS, "--plugin-dir", join(root, String(n + 1), "home/p")], good());
    expect(r.status, r.out).toBe(0);
    expect(r.paid).toEqual([]);
    expect(r.out).toContain("would run (paid, capped at $0.20): claude -p --setting-sources=project --max-budget-usd=0.20");
    expect(r.out).toContain("--confirm-paid");
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).not.toContain(up);
    expect(r.out).not.toContain(root);
    expect(r.out).not.toContain("someone@example.invalid");
  });

  test("runs once with --confirm-paid, with the cap, the prompt, the flags and claude's exit status, and no token in its output", () => {
    const r = live([...ARGS, "--confirm-paid", "--plugin-dir", "p", "--allowedTools", "Bash(ls *),Read", "--verbose", "--strict-mcp-config"], { shell: { ...good().shell, FAKE_EXIT: "3", ANTHROPIC_CUSTOM_HEADERS: "X-Auth: fixture-header", FAKE_SAY: "fixture-header" } });
    expect(r.status, r.out).toBe(3);
    expect(r.paid).toEqual(["-p --setting-sources=project --max-budget-usd=0.20 --plugin-dir=p --allowedTools=Bash(ls *),Read --strict-mcp-config --verbose"]);
    expect(r.out).toContain("PAID prompt=say hi token=[redacted]");
    expect(r.out).toContain("err [redacted]");
    expect(r.out).not.toMatch(/fixture-|X-Auth/);
  });

  test.each([["the shell", () => ({ shell: { ...good().shell, ANTHROPIC_BASE_URL: `${up}/` } })], ["kept settings", () => ({ user: settings() })]])("prints a gateway's 502 without the API address, host or hostname from %s", (_, options) => {
    const { host, hostname } = new URL(up), text = "API Error: 502 Bad Gateway. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway";
    const { shell, ...rest } = options();
    const r = live([...ARGS, "--confirm-paid", "--keep-user-endpoint"], { ...rest, shell: { ...shell, FAKE_SAY: `${text} (${host}). ${up}/v1 ${hostname}` } });
    expect(r.out).toContain(`${text} ([redacted]). [redacted]/v1 [redacted]`);
    expect(r.out).not.toContain(hostname);
  });

  test.each([["10.1.2.3:3128", "10.1.2.3:3128"], ["//proxyhost.corp:3128", "proxyhost.corp:3128"], ["proxyhost.corp:3128", "proxyhost.corp:3128"], ["proxyhost.corp/", "proxyhost.corp"], ["usr:pw@10.1.2.3:3128", "10.1.2.3:3128"], ["http://10.1.2.3:3128", "10.1.2.3:3128"]])("prints claude's proxy warning without the proxy %s, and leaves NO_PROXY alone", (proxy, host) => {
    const text = (shown) => `Invalid proxy URL in HTTPS_PROXY: "${shown}" cannot be parsed as a URL.`;
    const r = live([...ARGS, "--confirm-paid"], { shell: { ...good().shell, HTTPS_PROXY: proxy, NO_PROXY: "parsed", FAKE_SAY: `${text(proxy)} ${host} ${host.split(":")[0]}` } });
    expect(r.out).toContain(`${text(proxy.endsWith("/") ? "[redacted]/" : "[redacted]")} [redacted] [redacted]`);
  });

  test.each(["project", "local"])("prints no path of this machine and no secret that --version or the %s settings give", (source) => {
    const r = live([...ARGS, "--confirm-paid", "--setting-sources", "project,local"], { [source]: { DEPLOY_SECRET: "hidden-in-project" }, shell: { ...good().shell, A_KEY: "hidden-in", FAKE_SAY: "hidden-in-project", FAKE_VERSION: `${TOKEN}-project` } });
    expect(r.status, r.out).toBe(0);
    for (const value of [root, root.replace(/[^a-zA-Z0-9]/g, "-"), "-project", TOKEN]) expect(r.out).not.toContain(value);
  });

  test.each([
    ["no budget", ["--prompt", "hi"]],
    ["a zero budget", ["--prompt", "hi", "--max-budget-usd", "0"]],
    ["a budget that is not a number", ["--prompt", "hi", "--max-budget-usd", "lots"]],
    ["no prompt", ["--max-budget-usd", "0.20"]],
    ["a claude flag that could change what the preflight checked", [...ARGS, "--settings", "x.json"]],
    ["an extra argument", [...ARGS, "more"]],
    ["a --cwd that is not a folder", [...ARGS, "--cwd", "more".repeat(99)]],
    ["an unknown settings source", [...ARGS, "--setting-sources", "project,everything"]],
  ])("is refused before any call with %s", (_, args) => {
    const r = live([...args, "--confirm-paid"], good());
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.out).not.toContain("more");
  });
});

describe("the preflight stops the paid step", () => {
  const stopped = (options, ...args) => {
    const r = live([...ARGS, "--confirm-paid", ...args], options());
    expect(r.status, r.out).toBe(1);
    expect(r.paid).toEqual([]);
    expect(r.out).not.toContain(TOKEN);
    return r.out;
  };

  test("when claude is not on PATH", () => {
    expect(stopped(() => ({ ...good(), claude: false }))).toMatch(/FAIL +claude/);
  });

  test("when claude has no auth status command, without calling one", () => {
    const r = live([...ARGS, "--confirm-paid"], { shell: { ...good().shell, FAKE_OLD: "1" } });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(["--version", "auth status --help"]);
  });

  test("when claude is not logged in, naming a sandboxed tool as a cause", () => {
    expect(stopped(() => ({ shell: { ANTHROPIC_BASE_URL: up } }))).toMatch(/FAIL +login .*sandboxed tool.*own terminal/);
  });

  test("when --setting-sources drops the user's endpoint settings, naming them without values", () => {
    const out = stopped(() => ({ user: settings(), ...good() }));
    expect(out).toMatch(/FAIL +settings .*ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL.*--keep-user-endpoint/);
    expect(out).not.toContain("mapped");
  });

  test("when the endpoint refuses connections", () => {
    const out = stopped(() => ({ shell: { ...good().shell, ANTHROPIC_BASE_URL: down } }));
    expect(out).toMatch(/FAIL +endpoint .*the shell's ANTHROPIC_BASE_URL, which does not accept a connection/);
    expect(out).not.toContain(down);
  });

  test("when claude reads another address than the settings give", () => {
    expect(stopped(() => ({ shell: { ...good().shell, FAKE_URL: "http://127.0.0.1:1" } }))).toMatch(/FAIL +endpoint .*claude does not read the address/);
  });

  test("when the project's own settings set an endpoint, so a kept token cannot go there", () => {
    expect(stopped(() => ({ user: settings(), project: { ANTHROPIC_BASE_URL: up } }), "--keep-user-endpoint")).toMatch(/FAIL +settings .*ANTHROPIC_BASE_URL/);
  });

  test("when the run would use a cloud provider", () => {
    expect(stopped(() => ({ shell: { ...good().shell, CLAUDE_CODE_USE_BEDROCK: "1" } }))).toMatch(/FAIL +settings .*CLAUDE_CODE_USE_BEDROCK/);
  });

  test("when the user's settings cannot be read", () => {
    const out = stopped(() => ({ user: `{ "env": { "ANTHROPIC_AUTH_TOKEN": "${TOKEN}" `, ...good() }));
    expect(out).toMatch(/FAIL +settings +the user settings file is not valid JSON/);
    expect(out).not.toContain(root);
    expect(stopped(() => ({ user: { ...settings(), ANTHROPIC_MODEL: "null\0byte" } }), "--keep-user-endpoint")).not.toMatch(/null.*byte/);
    mkdirSync(join(root, "config/settings.json"), { recursive: true });
    expect(stopped(() => ({ shell: { ...good().shell, CLAUDE_CONFIG_DIR: join(root, "config") } }))).toMatch(/^FAIL +settings .*cannot be read/);
  });
});

describe("the user's endpoint settings", () => {
  test("reach the run with --keep-user-endpoint, over the shell's own", () => {
    const r = live([...ARGS, "--confirm-paid", "--keep-user-endpoint"], { user: settings(), shell: { ANTHROPIC_BASE_URL: down } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("token=[redacted] model=mapped");
    expect(r.out).toMatch(/ok +endpoint .*the user's settings, which accepts a connection/);
  });

  test("need nothing kept when --setting-sources includes user", () => {
    const r = live([...ARGS, "--setting-sources", "user,project"], { user: settings(), shell: { ANTHROPIC_BASE_URL: down } });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain("--setting-sources=user,project auth status --json");
  });

  test.each([["credentials", (url) => url.replace("//", "//u:hidden@")], ["a query", (url) => `${url}/?k=hidden`]])("stop the run when the address carries %s, without printing them", (_, change) => {
    const r = live([...ARGS, "--confirm-paid"], { shell: { ...good().shell, ANTHROPIC_BASE_URL: change(up) } });
    expect(r.status, r.out).toBe(1);
    expect(r.paid).toEqual([]);
    expect(r.out).toMatch(/FAIL +endpoint/);
    expect(r.out).not.toContain("hidden");
  });
});
