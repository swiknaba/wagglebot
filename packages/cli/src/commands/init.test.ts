import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runInit } from "./init";

const quiet = () => createReporter(() => {}, false);

test("scaffolds the company repository with the version substituted", () => {
  const target = mkdtempSync(join(tmpdir(), "wgl-init-"));
  mkdirSync(join(target, ".git")); // a fresh clone is allowed
  const code = runInit({ targetDir: target, version: "1.4.2", reporter: quiet() });
  expect(code).toBe(0);
  const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  expect(pkg.dependencies.wagglebot).toBe("1.4.2");
  expect(pkg.scripts["update:wagglebot"]).toBe("wagglebot update");
  for (const f of [
    "teams/team-payments/catalog.yaml",
    "teams/team-payments/README.md",
    "company/registry.yaml",
    "tool_catalog.yaml",
    "company/skills.list",
    "company/agents.list",
    ".gitignore",
    ".nvmrc",
    ".env.credentials.example",
    "docker-compose.override.yml",
    "README.md",
    "company/instructions/00-example.md",
    "company/agents/README.md",
  ]) {
    expect(existsSync(join(target, f))).toBe(true);
  }
  expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain(".env.credentials");
});

test("refuses a non-empty directory", () => {
  const target = mkdtempSync(join(tmpdir(), "wgl-init-"));
  writeFileSync(join(target, "existing.txt"), "x");
  const r = createReporter(() => {}, false);
  expect(runInit({ targetDir: target, version: "1.4.2", reporter: r })).toBe(1);
  expect(r.failed()).toBe(true);
});
