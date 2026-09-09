import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, templatesDir } from "./harness";

test("the harness table carries the verified targets", () => {
  expect(HARNESSES.map((h) => h.name)).toEqual(["claude-code", "codex", "junie", "cline", "gemini", "copilot"]);
  const claude = HARNESSES[0];
  expect(claude?.templateTargets).toEqual([".claude/CLAUDE.md"]);
  expect(claude?.mcpTarget).toEqual({
    format: "json",
    path: ".claude.json",
    parentKey: "mcpServers",
    dialect: "claude",
  });
  expect(claude?.subagentDir).toBe(".claude/agents");
  expect(HARNESSES.find((h) => h.name === "gemini")?.templateTargets).toEqual([".gemini/GEMINI.md"]);
  expect(HARNESSES.find((h) => h.name === "junie")?.subagentDir).toBe(".junie/agents");
  expect(HARNESSES.filter((h) => h.hooksTarget !== undefined)).toHaveLength(1);
  for (const h of HARNESSES) expect(h.detectDir.startsWith(".")).toBe(true);
});

test("the harness table carries the project targets sync-project needs", () => {
  const byName = Object.fromEntries(HARNESSES.map((h) => [h.name, h.projectTarget]));
  expect(byName["claude-code"]).toEqual({ path: "CLAUDE.md", mode: "import", importLine: "@AGENTS.md" });
  expect(byName.codex).toEqual({ path: "AGENTS.md", mode: "block", warnBytes: 32 * 1024 });
  expect(byName.junie).toEqual({ path: "AGENTS.md", mode: "block" });
  expect(byName.cline).toEqual({ path: "AGENTS.md", mode: "block" });
  expect(byName.gemini).toEqual({ path: "GEMINI.md", mode: "import", importLine: "@./AGENTS.md" });
  expect(byName.copilot).toEqual({ path: ".github/copilot-instructions.md", mode: "block" });
});

test("shipped template files exist", () => {
  expect(existsSync(join(templatesDir(), "AGENTS.base.md"))).toBe(true);
  expect(existsSync(join(templatesDir(), "hooks", "claude-code.json"))).toBe(true);
});

test("every MCP target is home-relative and names its dialect", () => {
  for (const h of HARNESSES) {
    const t = h.mcpTarget;
    if (t === undefined) continue;
    expect(t.path.startsWith(".")).toBe(true);
    expect(t.path).not.toContain("~");
    expect(t.dialect.length).toBeGreaterThan(0);
  }
  expect(HARNESSES.find((h) => h.name === "codex")?.mcpTarget).toEqual({
    format: "toml",
    path: ".codex/config.toml",
    table: "mcp_servers",
    dialect: "codex",
  });
  expect(HARNESSES.find((h) => h.name === "gemini")?.mcpTarget).toEqual({
    format: "json",
    path: ".gemini/settings.json",
    parentKey: "mcpServers",
    dialect: "gemini",
  });
  expect(HARNESSES.find((h) => h.name === "copilot")?.mcpTarget).toEqual({
    format: "json",
    path: ".copilot/mcp-config.json",
    parentKey: "mcpServers",
    dialect: "copilot",
  });
});
