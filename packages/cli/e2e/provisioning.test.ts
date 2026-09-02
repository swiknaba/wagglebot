import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBuilt, repoRoot, runCli } from "./helper";

// Copies the committed test-app/ reference into a scratch directory, runs the real
// `sync-agents` command with a sandboxed HOME, and checks it provisions every harness
// idempotently: the first run writes managed blocks, the second run reports them unchanged.
let appDir: string;
let scratchHome: string;

beforeAll(() => {
  ensureBuilt();
  const workDir = mkdtempSync(join(tmpdir(), "wagglebot-provisioning-app-"));
  appDir = join(workDir, "test-app");
  cpSync(join(repoRoot, "test-app"), appDir, { recursive: true });
  scratchHome = mkdtempSync(join(tmpdir(), "wagglebot-provisioning-home-"));
  // Harness selection detects a harness by the presence of its home directory (harness-select.ts).
  // Create only .claude, so detection finds one harness and the other stays untouched.
  mkdirSync(join(scratchHome, ".claude"), { recursive: true });
  // sync-shell reads the shell script from the company repository's node_modules, the way a
  // real `yarn install` leaves it. Simulate that install by copying the shipped script in.
  mkdirSync(join(appDir, "node_modules/wagglebot/templates/shell"), { recursive: true });
  cpSync(
    join(repoRoot, "packages/cli/templates/shell/wagglebot.sh"),
    join(appDir, "node_modules/wagglebot/templates/shell/wagglebot.sh"),
  );
  // sync-agents now resolves the engineer's identity from the catalog. Store a known
  // username instead of prompting an interactive question the test cannot answer, in a
  // scratch global git config that never touches the real machine.
  const env = { ...process.env, HOME: scratchHome, GIT_CONFIG_GLOBAL: join(scratchHome, ".gitconfig") };
  execFileSync("git", ["config", "--global", "wagglebot.username", "alice"], { env });
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  rmSync(scratchHome, { recursive: true, force: true });
});

test("sync-agents provisions every harness under a sandboxed HOME", () => {
  const env = { ...process.env, HOME: scratchHome, GIT_CONFIG_GLOBAL: join(scratchHome, ".gitconfig") };

  const first = runCli(["sync-agents"], { cwd: appDir, env });
  expect(first.status).toBe(0);

  const claudeMd = join(scratchHome, ".claude", "CLAUDE.md");
  expect(existsSync(claudeMd)).toBe(true);
  const claudeMdText = readFileSync(claudeMd, "utf8");
  expect(claudeMdText).toContain("<!-- wagglebot:begin -->");
  expect(claudeMdText).toContain("## Memory");

  // .gemini was never created in the sandbox HOME, so detection must not find it and
  // sync-agents must not create it.
  expect(existsSync(join(scratchHome, ".gemini"))).toBe(false);

  const settingsPath = join(scratchHome, ".claude", "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  expect(readFileSync(settingsPath, "utf8")).toContain("wagglebot:");

  const second = runCli(["sync-agents"], { cwd: appDir, env });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("already ok");
  expect(second.stdout).not.toContain("synced");

  const shell = runCli(["sync-shell"], { cwd: appDir, env });
  expect(shell.status).toBe(0);
  const zshenvText = readFileSync(join(scratchHome, ".zshenv"), "utf8");
  expect(zshenvText).toContain("# wagglebot:begin");

  const help = runCli(["write-mcp", "--help"], { cwd: appDir, env });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("~/.claude.json");
});
