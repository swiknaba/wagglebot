import { expect, test } from "bun:test";
import { helpText } from "./help";

test("general help lists every command and the two git config keys", () => {
  const text = helpText();
  for (const c of ["update", "init", "install-skills", "install-agents", "sync-agents", "sync-shell", "write-mcp"])
    expect(text).toContain(`  ${c}`);
  expect(text).toContain("wagglebot.username");
  expect(text).toContain("wagglebot.harnesses");
});

test("command help names what the command reads and writes", () => {
  const sync = helpText("sync-agents");
  expect(sync).toContain("company/instructions/");
  expect(sync).toContain("~/.claude/CLAUDE.md");
  expect(sync).not.toContain("~/.claude.json");
  const mcp = helpText("write-mcp");
  expect(mcp).toContain("registry.yaml");
  expect(mcp).toContain("~/.claude.json");
  const shell = helpText("sync-shell");
  expect(shell).toContain("~/.zshenv");
  expect(shell).toContain(".env.credentials");
  const update = helpText("update");
  expect(update).toContain("~/.zshenv");
  expect(update).toContain("~/.claude/agents/");
});

test("unknown command help falls back to the general text", () => {
  expect(helpText("nope")).toBe(helpText());
});
