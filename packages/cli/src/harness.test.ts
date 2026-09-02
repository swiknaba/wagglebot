import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, templatesDir } from "./harness";

test("the harness table carries the verified targets", () => {
  expect(HARNESSES.map((h) => h.name)).toEqual(["claude-code", "codex", "junie", "cline", "gemini", "copilot"]);
  const claude = HARNESSES[0];
  expect(claude?.templateTargets).toEqual([".claude/CLAUDE.md"]);
  expect(claude?.mcpTarget).toEqual({ path: ".claude.json", parentKey: "mcpServers" });
  expect(claude?.subagentDir).toBe(".claude/agents");
  expect(HARNESSES.find((h) => h.name === "gemini")?.templateTargets).toEqual([".gemini/GEMINI.md"]);
  expect(HARNESSES.find((h) => h.name === "junie")?.subagentDir).toBe(".junie/agents");
  expect(HARNESSES.filter((h) => h.hooksTarget !== undefined)).toHaveLength(1);
  for (const h of HARNESSES) expect(h.detectDir.startsWith(".")).toBe(true);
});

test("shipped template files exist", () => {
  expect(existsSync(join(templatesDir(), "AGENTS.base.md"))).toBe(true);
  expect(existsSync(join(templatesDir(), "hooks", "claude-code.json"))).toBe(true);
});
