// tools/privacy-check.mjs is the gate that keeps personal content out of this public
// repository. Each rule gets a planted positive and a near-miss that must pass.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEmail, checkIdentity, checkLine, checkPath, loadPrivateRules } from "../tools/privacy-check.mjs";

const tool = fileURLToPath(new URL("../tools/privacy-check.mjs", import.meta.url));
const none = { terms: [], vaultFiles: new Set(), vaultTitles: [] };
// Built at runtime so this file passes the check it tests.
const vaultWord = ["Main", "Vault"].join("");
const realHome = ["/Users", "jdoe42", "notes"].join("/");

describe("public rules", () => {
  test("a home path with a real-looking user name is flagged", () => {
    expect(checkLine(`see ${realHome}/a.md`, none)).toEqual(["home-path"]);
    expect(checkLine(["C:", "Users", "jdoe42", "x"].join("\\"), none)).toEqual(["home-path"]);
    expect(checkLine(["", "home", "jdoe42", ".cache"].join("/"), none)).toEqual(["home-path"]);
  });

  test("placeholder home paths pass", () => {
    for (const line of ["/Users/you/my_app", "C:/Users/name/potluck", "/home/u/.claude", "/home/runner/work", "/Users/<you>/x", "$HOME/.config", "such as /Users/you."]) {
      expect(checkLine(line, none)).toEqual([]);
    }
  });

  test("the vault name is flagged in any case", () => {
    expect(checkLine(`~/Documents/${vaultWord}/x`, none)).toEqual(["vault-name"]);
    expect(checkLine(vaultWord.toLowerCase(), none)).toEqual(["vault-name"]);
  });

  test("env and local json files are flagged by name", () => {
    expect(checkPath("app/.env", none)).toEqual(["env-file"]);
    expect(checkPath(".env.production", none)).toEqual(["env-file"]);
    expect(checkPath(".claude/settings.local.json", none)).toEqual(["local-json"]);
    expect(checkPath(".env.example", none)).toEqual([]);
    expect(checkPath("docs/env.md", none)).toEqual([]);
  });
});

test("an email address is flagged unless it is a noreply, an SSH remote, or an example", () => {
  // Built at runtime so this file passes the check it tests.
  for (const address of [["jdoe42", "gmail.com"], ["a.b+c", "mail.company.co.uk"], ["ab", "Someones-MacBook.local"], ["x", "notexample.com"]].map((p) => p.join("@"))) {
    expect([address, checkEmail(`mail ${address} today`)]).toEqual([address, ["email"]]);
  }
  for (const line of ["1+ab@users.noreply.github.com", "git@github.com:Me/Widgets.git", "t@example.com", "x@sub.example.org", "fixture@example.invalid", "a@b.test", "a@host.localhost", "react@18.3.1", "@AGENTS.md", "pnpm add @scope/pkg@latest"]) {
    expect([line, checkEmail(line)]).toEqual([line, []]);
  }
});

test("commit identities on machine-local hosts are flagged", () => {
  expect(checkIdentity(`A B <ab@${"Someones-MacBook"}.local>`, none)).toEqual(["local-email"]);
  expect(checkIdentity("A B <ab@localhost>", none)).toEqual(["local-email"]);
  expect(checkIdentity("A B <1+ab@users.noreply.github.com>", none)).toEqual([]);
  expect(checkIdentity("Real Person <x@example.com>", { ...none, terms: ["real person"] })).toEqual(["private-term"]);
});

describe("private rules", () => {
  function withTerms(lines, fn) {
    const dir = mkdtempSync(join(tmpdir(), "potluck-privacy-"));
    try {
      const vault = join(dir, "vault");
      mkdirSync(join(vault, "notes"), { recursive: true });
      writeFileSync(join(vault, "notes", "读书笔记索引.md"), "x");
      writeFileSync(join(vault, "notes", "template.md"), "x");
      writeFileSync(join(dir, "terms.txt"), [...lines, `vault: ${vault}`].join("\n"));
      fn(loadPrivateRules({ POTLUCK_PRIVATE_TERMS: join(dir, "terms.txt") }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("terms match case-insensitively and comments are ignored", () => {
    withTerms(["# a comment", "SecretHandle"], (rules) => {
      expect(rules.terms).toEqual(["secrethandle"]);
      expect(checkLine("by secrethandle", rules)).toEqual(["private-term"]);
      expect(checkLine("a comment", rules)).toEqual([]);
    });
  });

  test("distinctive vault names are flagged, generic ones pass", () => {
    withTerms([], (rules) => {
      expect(checkLine("见 读书笔记索引 一节", rules)).toEqual(["vault-file"]);
      expect(checkPath("docs/读书笔记索引.md", rules)).toEqual(["vault-file"]);
      expect(checkLine("issue template", rules)).toEqual([]);
      expect(checkPath(".github/template.md", rules)).toEqual([]);
    });
  });

  test("a missing terms file means public rules only", () => {
    expect(loadPrivateRules({ POTLUCK_PRIVATE_TERMS: join(tmpdir(), "potluck-no-such-file") }).source).toBeNull();
  });
});

describe("modes", () => {
  function repo(fn) {
    const dir = mkdtempSync(join(tmpdir(), "potluck-privacy-repo-"));
    const run = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      run("init", "-q", "-b", "main");
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "t");
      run("config", "commit.gpgsign", "false");
      fn(dir, run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const check = (dir, mode) =>
    spawnSync("node", [tool, mode], { cwd: dir, encoding: "utf8", env: { ...process.env, POTLUCK_PRIVATE_TERMS: join(dir, "none") } });

  test("--staged blocks a staged home path and passes once it is replaced", () => {
    repo((dir, run) => {
      writeFileSync(join(dir, "a.md"), `path ${realHome}\n`);
      run("add", "a.md");
      const bad = check(dir, "--staged");
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("a.md:1: home-path");
      expect(bad.stderr).not.toContain("jdoe42");
      writeFileSync(join(dir, "a.md"), "path /Users/you/notes\n");
      run("add", "a.md");
      expect(check(dir, "--staged").status).toBe(0);
    });
  });

  test("--staged and --tree flag an email address, and --history leaves that rule out", () => {
    repo((dir, run) => {
      const address = ["jdoe42", "gmail.com"].join("@");
      writeFileSync(join(dir, "a.md"), `mail ${address}\n`);
      run("add", "a.md");
      const staged = check(dir, "--staged");
      expect(staged.status).toBe(1);
      expect(staged.stderr).toContain("a.md:1: email");
      run("commit", "-qm", "one", "--no-verify");
      expect(check(dir, "--tree").stderr).toContain("a.md:1: email");
      expect(check(dir, "--history").status).toBe(0);
    });
  });

  test("--history finds a line a later commit removed", () => {
    repo((dir, run) => {
      writeFileSync(join(dir, "a.md"), `${vaultWord}\n`);
      run("add", "a.md");
      run("commit", "-qm", "one");
      writeFileSync(join(dir, "a.md"), "clean\n");
      run("commit", "-qam", "two");
      expect(check(dir, "--tree").status).toBe(0);
      const hist = check(dir, "--history");
      expect(hist.status).toBe(1);
      expect(hist.stderr).toContain("a.md: vault-name");
    });
  });

  test("an unknown mode is a usage error", () => {
    repo((dir) => expect(check(dir, "--everything").status).toBe(2));
  });
});
