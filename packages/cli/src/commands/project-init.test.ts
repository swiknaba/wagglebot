import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runProjectInit } from "./project-init";
import { PROJECT_CHANGELOG_FILE, PROJECT_INSTRUCTIONS_DIR } from "./project-update";

const quiet = () => createReporter(() => {}, false);

function setupRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-project-init-")));
  mkdirSync(join(repo, ".git"));
  return repo;
}

test("project init creates the project agent files without a catalog or gitignore entry", () => {
  const repo = setupRepo();

  expect(runProjectInit({ cwd: repo, reporter: quiet() })).toBe(0);

  expect(existsSync(join(repo, PROJECT_INSTRUCTIONS_DIR))).toBe(true);
  expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).toContain('okf_version: "0.2"');
  expect(readFileSync(join(repo, ".agents/memory/component.md"), "utf8")).toContain("# Component Overview");
  expect(readFileSync(join(repo, PROJECT_CHANGELOG_FILE), "utf8")).toBe(
    "# Agent Changelog\n\n<!-- Add dated Added, Changed, Fixed, or Removed sections after meaningful repository changes. -->\n",
  );
  expect(existsSync(join(repo, "catalog-info.yaml"))).toBe(false);
  expect(existsSync(join(repo, ".gitignore"))).toBe(false);
});

test("project init performs the first update and preserves existing project files", () => {
  const repo = setupRepo();
  const instructions = join(repo, PROJECT_INSTRUCTIONS_DIR);
  const memory = "---\ntype: Architecture\ntitle: Ownership Map\n---\n\nThe concept stays exact.\r\n";
  const changelog = "Changelog stays exact\r\n";
  mkdirSync(instructions, { recursive: true });
  writeFileSync(join(instructions, "rules.md"), "Use tests.\n");
  mkdirSync(join(repo, ".agents/memory/architecture"), { recursive: true });
  writeFileSync(join(repo, ".agents/memory/architecture/ownership.md"), memory);
  writeFileSync(join(repo, ".agents/memory/index.md"), '---\nokf_version: "0.2"\n---\n\n# Stale index\n');
  writeFileSync(join(repo, PROJECT_CHANGELOG_FILE), changelog);

  expect(runProjectInit({ cwd: repo, reporter: quiet() })).toBe(0);

  expect(readFileSync(join(repo, ".agents/memory/architecture/ownership.md"), "utf8")).toBe(memory);
  expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).toContain("architecture/index.md");
  expect(readFileSync(join(repo, ".agents/memory/architecture/index.md"), "utf8")).toContain("Ownership Map");
  expect(readFileSync(join(repo, PROJECT_CHANGELOG_FILE), "utf8")).toBe(changelog);
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("Use tests.");
});

test("project init requires a Git repository before it creates project files", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wgl-project-init-")));

  expect(() => runProjectInit({ cwd: outside, reporter: quiet() })).toThrow(/Git repository/);
  expect(existsSync(join(outside, ".agents"))).toBe(false);
});
