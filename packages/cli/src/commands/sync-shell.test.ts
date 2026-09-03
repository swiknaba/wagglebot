import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runSyncShell, shellRcTargets } from "./sync-shell";

const quiet = () => createReporter(() => {}, false);
const home = () => mkdtempSync(join(tmpdir(), "wgl-shell-"));
const companyRoot = () => mkdtempSync(join(tmpdir(), "wgl-company-"));
// Every test pins $SHELL. The real value of the machine that runs the suite must not
// decide which startup file sync-shell creates.
const zsh = { SHELL: "/bin/zsh" };
const bash = { SHELL: "/bin/bash" };
// A company root that carries the shipped shell script, the way `yarn install` leaves it.
const companyRootWithScript = () => {
  const dir = companyRoot();
  mkdirSync(join(dir, "node_modules/wagglebot/templates/shell"), { recursive: true });
  writeFileSync(join(dir, "node_modules/wagglebot/templates/shell/wagglebot.sh"), "# script\n");
  return dir;
};

test("writes a hash-marker block to .zshenv and leaves a missing .bashrc alone", () => {
  const h = home();
  const company = companyRootWithScript();
  expect(runSyncShell({ home: h, companyRoot: company, reporter: quiet(), env: zsh })).toBe(0);
  const zshenv = readFileSync(join(h, ".zshenv"), "utf8");
  expect(zshenv).toContain("# wagglebot:begin");
  expect(zshenv).toContain(`export WAGGLEBOT_COMPANY_REPO="${company}"`);
  expect(zshenv).toContain("node_modules/wagglebot/templates/shell/wagglebot.sh");
  expect(existsSync(join(h, ".bashrc"))).toBe(false);
});

test("an existing .bashrc gets the block and keeps its content; second run is ok", () => {
  const h = home();
  const company = companyRootWithScript();
  writeFileSync(join(h, ".bashrc"), "alias ll='ls -l'\n");
  runSyncShell({ home: h, companyRoot: company, reporter: quiet(), env: zsh });
  const bashrc = readFileSync(join(h, ".bashrc"), "utf8");
  expect(bashrc.startsWith("alias ll='ls -l'\n")).toBe(true);
  expect(bashrc).toContain("# wagglebot:end");
  const r = createReporter(() => {}, false);
  expect(runSyncShell({ home: h, companyRoot: company, reporter: r, env: zsh })).toBe(0);
  expect(r.counts()).toMatchObject({ ok: 2, updated: 0 });
});

// The WSL case: a distribution that ships bash alone must not get a .zshenv nothing reads.
test("a bash login shell writes .bashrc and skips a missing .zshenv", () => {
  const h = home();
  const company = companyRootWithScript();
  writeFileSync(join(h, ".bashrc"), "");
  const r = createReporter(() => {}, false);
  expect(runSyncShell({ home: h, companyRoot: company, reporter: r, env: bash })).toBe(0);
  expect(readFileSync(join(h, ".bashrc"), "utf8")).toContain("# wagglebot:begin");
  expect(existsSync(join(h, ".zshenv"))).toBe(false);
  expect(r.counts().skipped).toBe(1);
});

test("a bash login shell still creates a missing .bashrc", () => {
  const h = home();
  const company = companyRootWithScript();
  expect(runSyncShell({ home: h, companyRoot: company, reporter: quiet(), env: bash })).toBe(0);
  expect(readFileSync(join(h, ".bashrc"), "utf8")).toContain("# wagglebot:begin");
});

test("a moved company repository rewrites the block", () => {
  const h = home();
  runSyncShell({ home: h, companyRoot: "/old", reporter: quiet(), env: zsh });
  const r = createReporter(() => {}, false);
  runSyncShell({ home: h, companyRoot: "/new", reporter: r, env: zsh });
  expect(r.counts().updated).toBe(1);
  expect(readFileSync(join(h, ".zshenv"), "utf8")).not.toContain("/old");
});

test("a missing shipped script is reported and failed, but the block is still written", () => {
  const h = home();
  const company = companyRoot();
  const r = createReporter(() => {}, false);
  expect(runSyncShell({ home: h, companyRoot: company, reporter: r, env: zsh })).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(readFileSync(join(h, ".zshenv"), "utf8")).toContain("# wagglebot:begin");
});

test("a company repository that carries the shipped script exits 0", () => {
  const h = home();
  const company = companyRootWithScript();
  expect(runSyncShell({ home: h, companyRoot: company, reporter: quiet(), env: zsh })).toBe(0);
});

test("a sibling startup file proves the shell is in use, whatever $SHELL says", () => {
  const h = home();
  writeFileSync(join(h, ".zshrc"), "");
  const targets = shellRcTargets(h, bash);
  expect(targets.find((t) => t.file === ".zshenv")?.createIfMissing).toBe(true);
  expect(targets.find((t) => t.file === ".bashrc")?.createIfMissing).toBe(true);
});

test("an unset or unknown $SHELL falls back to .zshenv alone", () => {
  const h = home();
  for (const env of [{}, { SHELL: "/usr/bin/fish" }]) {
    const targets = shellRcTargets(h, env);
    expect(targets.find((t) => t.file === ".zshenv")?.createIfMissing).toBe(true);
    expect(targets.find((t) => t.file === ".bashrc")?.createIfMissing).toBe(false);
  }
});
