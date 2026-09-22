import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, ensureBuilt, git, initGit, isolatedEnv, runCli, snapshot } from "./helper";

let scratch: string;
beforeAll(() => {
  ensureBuilt();
  scratch = mkdtempSync(join(tmpdir(), "wagglebot-project-e2e-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("project init and update preserve lifecycle files and publish every project target idempotently", () => {
  const repo = join(scratch, "project");
  mkdirSync(repo);
  const env = isolatedEnv(join(scratch, "home"));
  initGit(repo, env);
  const read = (path: string) => readFileSync(join(repo, path), "utf8");
  const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
  const first = runCli(["init"], { cwd: repo, env });
  expect(first.status, first.stdout).toBe(0);
  expect(existsSync(join(repo, ".agents/instructions"))).toBe(true);
  expect(read(".agents/memory.md")).toContain("# Component Memory");
  expect(read(".agents/changelog.md")).toContain("# Agent Changelog");
  expect(existsSync(join(repo, "catalog-info.yaml"))).toBe(false);
  const expectedMemory = "# Durable memory\n\nMemory must stay private to this file.\n";
  const expectedChangelog = "# Agent Changelog\n\n## 2026-09-21\n\n### Added\n\n- Changelog sentinel.\n";
  write(".agents/memory.md", expectedMemory);
  write(".agents/changelog.md", expectedChangelog);
  mkdirSync(join(repo, ".agents/subagents"));
  write(".agents/subagents/review.md", "Unrelated agent sentinel.\n");
  write(".agents/instructions/10-testing.md", "# Testing\n\nWrite a test first.\n");
  write(".agents/instructions/00-style.md", "# Style\n\nUse two spaces.\n");
  mkdirSync(join(repo, ".github"));
  // Six harnesses share AGENTS.md. Claude, Gemini, and Copilot have separate targets.
  const targets = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"];
  for (const path of targets) write(path, `# Personal ${path}\n`);
  write(".gitignore", "node_modules/\n");
  mkdirSync(join(repo, "src/deep"), { recursive: true });
  const nested = join(repo, "src/deep");
  const init = runCli(["init"], { cwd: nested, env });
  expect(init.status, init.stdout).toBe(0);
  for (const path of targets) {
    const content = read(path);
    expect(content).toStartWith(`# Personal ${path}\n`);
    expect(content).not.toContain("Memory must stay private");
    expect(content).not.toContain("Changelog sentinel");
    expect(content).not.toContain("Unrelated agent sentinel");
    if (path === "CLAUDE.md") expect(content).toContain("@AGENTS.md");
    else if (path === "GEMINI.md") expect(content).toContain("@./AGENTS.md");
    else {
      expect(content).toContain("Write a test first.");
      expect(content).toContain("Use two spaces.");
      expect(content.indexOf("Use two spaces.")).toBeLessThan(content.indexOf("Write a test first."));
    }
  }
  expect(read(".agents/memory.md")).toBe(expectedMemory);
  expect(read(".agents/changelog.md")).toBe(expectedChangelog);
  commitAll(repo, env);
  expect(git(repo, env, "ls-files", ".agents/memory.md", ".agents/changelog.md").trim().split("\n")).toEqual([
    ".agents/changelog.md",
    ".agents/memory.md",
  ]);
  const before = snapshot(repo, new Set([".git"]));
  const update = runCli(["update"], { cwd: nested, env });
  expect(update.status, update.stdout).toBe(0);
  expect(update.stdout).not.toMatch(/^ {2}(?:installed|updated|failed)\s/m);
  expect(snapshot(repo, new Set([".git"]))).toEqual(before);
  expect(git(repo, env, "status", "--porcelain")).toBe("");

  rmSync(join(repo, ".agents/instructions/10-testing.md"));
  expect(runCli(["update"], { cwd: nested, env }).status).toBe(0);
  expect(read("AGENTS.md")).not.toContain("Write a test first.");
  rmSync(join(repo, ".agents/instructions/00-style.md"));
  expect(runCli(["update"], { cwd: nested, env }).status).toBe(0);
  for (const path of targets) expect(read(path)).toBe(`# Personal ${path}\n`);
  expect(read(".agents/memory.md")).toBe(expectedMemory);
  expect(read(".agents/changelog.md")).toBe(expectedChangelog);
  expect(read(".gitignore")).toBe("node_modules/\n");
  rmSync(join(repo, ".agents/memory.md"));
  rmSync(join(repo, ".agents/changelog.md"));
  expect(runCli(["update"], { cwd: nested, env }).status).toBe(0);
  expect(read(".agents/memory.md")).toContain("# Component Memory");
  expect(read(".agents/changelog.md")).toContain("# Agent Changelog");
  expect(existsSync(join(env.HOME ?? "", ".wagglebot"))).toBe(false);
});
