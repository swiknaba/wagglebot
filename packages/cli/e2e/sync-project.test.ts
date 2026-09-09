import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBuilt, runCli } from "./helper";

// Exercises the real `sync-project` command end to end: a Git repository with two instruction
// sources, run from a nested subdirectory, against a sandboxed HOME. Covers the full lifecycle:
// create, idempotent re-run, removing one source, and removing the last source (which deletes the
// generated files). The command keeps no state of its own — git is the undo — so the sandboxed
// HOME never grows a ~/.wagglebot directory across any of these runs.
let repoDir: string;
let nestedCwd: string;
let scratchHome: string;

const env = () => ({ ...process.env, HOME: scratchHome });

beforeAll(() => {
  ensureBuilt();
  repoDir = mkdtempSync(join(tmpdir(), "wagglebot-sync-project-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  scratchHome = mkdtempSync(join(tmpdir(), "wagglebot-sync-project-home-"));

  mkdirSync(join(repoDir, ".agents", "instructions"), { recursive: true });
  writeFileSync(join(repoDir, ".agents", "instructions", "00-style.md"), "# Style\n\nUse two spaces.\n");
  writeFileSync(join(repoDir, ".agents", "instructions", "10-testing.md"), "# Testing\n\nWrite a test first.\n");
  writeFileSync(join(repoDir, "CLAUDE.md"), "# Personal notes\n");

  nestedCwd = join(repoDir, "src", "deep");
  mkdirSync(nestedCwd, { recursive: true });
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(scratchHome, { recursive: true, force: true });
});

test("sync-project creates every project target from a nested directory", () => {
  const first = runCli(["sync-project"], { cwd: nestedCwd, env: env() });
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(" B");

  const agentsMd = readFileSync(join(repoDir, "AGENTS.md"), "utf8");
  const styleIndex = agentsMd.indexOf("Use two spaces.");
  const testingIndex = agentsMd.indexOf("Write a test first.");
  expect(styleIndex).toBeGreaterThan(-1);
  expect(testingIndex).toBeGreaterThan(-1);
  expect(styleIndex).toBeLessThan(testingIndex);

  const claudeMd = readFileSync(join(repoDir, "CLAUDE.md"), "utf8");
  expect(claudeMd.startsWith("# Personal notes")).toBe(true);
  expect(claudeMd).toContain("@AGENTS.md");

  const geminiMd = readFileSync(join(repoDir, "GEMINI.md"), "utf8");
  expect(geminiMd).toContain("@./AGENTS.md");

  expect(existsSync(join(repoDir, ".github", "copilot-instructions.md"))).toBe(true);
});

test("a second run reports every target already ok", () => {
  const second = runCli(["sync-project"], { cwd: nestedCwd, env: env() });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("already ok");
  expect(second.stdout).not.toContain("created");
  expect(second.stdout).not.toContain("synced");
});

test("removing one source removes its text", () => {
  rmSync(join(repoDir, ".agents", "instructions", "10-testing.md"));
  const real = runCli(["sync-project"], { cwd: nestedCwd, env: env() });
  expect(real.status).toBe(0);
  const agentsMd = readFileSync(join(repoDir, "AGENTS.md"), "utf8");
  expect(agentsMd).not.toContain("Write a test first.");
  expect(agentsMd).toContain("Use two spaces.");
});

test("removing the last source deletes every generated target", () => {
  rmSync(join(repoDir, ".agents", "instructions", "00-style.md"));
  const removed = runCli(["sync-project"], { cwd: nestedCwd, env: env() });
  expect(removed.status).toBe(0);
  expect(existsSync(join(repoDir, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(repoDir, "GEMINI.md"))).toBe(false);
  expect(existsSync(join(repoDir, ".github", "copilot-instructions.md"))).toBe(false);
  expect(readFileSync(join(repoDir, "CLAUDE.md"), "utf8")).toBe("# Personal notes\n");
});

test("--help documents the targets", () => {
  const help = runCli(["sync-project", "--help"], { cwd: nestedCwd, env: env() });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("AGENTS.md");
});

test("the sandboxed HOME never grows a ~/.wagglebot directory", () => {
  expect(existsSync(join(scratchHome, ".wagglebot"))).toBe(false);
});
