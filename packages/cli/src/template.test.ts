import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "./template";

test("concatenates base and instructions with blank-line separators", () => {
  expect(renderTemplate("# Base\n", ["## Team A\n", "## Team B"])).toBe("# Base\n\n## Team A\n\n## Team B\n");
});

test("no instructions returns the base normalized", () => {
  expect(renderTemplate("# Base", [])).toBe("# Base\n");
});

test("base instructions require a changelog before final response and exclude research-only work", () => {
  const text = readFileSync(join(import.meta.dir, "..", "templates", "AGENTS.base.md"), "utf8");
  expect(text).toContain("Before the final response");
  expect(text).toContain("Do not record research, failed attempts, or sessions that make no change.");
});

test("base instructions define progressive context and explicit bridge use", () => {
  const text = readFileSync(join(import.meta.dir, "..", "templates", "AGENTS.base.md"), "utf8");
  for (const phrase of [
    "new chat",
    "L0",
    "Use L1\nonly",
    "context cursor",
    "current source",
    "`brain_memory_propose`",
    "developer explicitly asks",
    "Never save a transcript",
  ])
    expect(text).toContain(phrase);
});
