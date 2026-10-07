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

test("base instructions favor clear sentences without forcing telegraphic prose", () => {
  const text = readFileSync(join(import.meta.dir, "..", "templates", "AGENTS.base.md"), "utf8");

  expect(text).toContain("Do not force threes");
  expect(text).toContain("necessary connections");
  expect(text).not.toContain("Use no more than 20 words");
  expect(text).not.toContain("Use no more than 25 words");
});
