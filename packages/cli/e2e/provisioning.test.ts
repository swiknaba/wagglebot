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
  // Create the two directories this test provisions into, so both are detected.
  mkdirSync(join(scratchHome, ".claude"), { recursive: true });
  mkdirSync(join(scratchHome, ".gemini"), { recursive: true });
  // sync-agents now resolves the engineer's identity from the catalog. Store a known
  // username instead of prompting an interactive question the test cannot answer.
  execFileSync("git", ["config", "--global", "wagglebot.username", "alice"], {
    env: { ...process.env, HOME: scratchHome },
  });
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
  rmSync(scratchHome, { recursive: true, force: true });
});

test("sync-agents provisions every harness under a sandboxed HOME", () => {
  const env = { ...process.env, HOME: scratchHome };

  const first = runCli(["sync-agents"], { cwd: appDir, env });
  expect(first.status).toBe(0);

  const claudeMd = join(scratchHome, ".claude", "CLAUDE.md");
  expect(existsSync(claudeMd)).toBe(true);
  const claudeMdText = readFileSync(claudeMd, "utf8");
  expect(claudeMdText).toContain("<!-- wagglebot:begin -->");
  expect(claudeMdText).toContain("## Memory");

  expect(existsSync(join(scratchHome, ".gemini", "GEMINI.md"))).toBe(true);

  const settingsPath = join(scratchHome, ".claude", "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  expect(readFileSync(settingsPath, "utf8")).toContain("wagglebot:");

  const second = runCli(["sync-agents"], { cwd: appDir, env });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("already ok");
  expect(second.stdout).not.toContain("synced");
});
