import { expect, test } from "bun:test";
import { helpText } from "./help";

test("general help lists every command and the user git config key", () => {
  const text = helpText();
  for (const c of [
    "connect",
    "update",
    "init",
    "install-skills",
    "install-agents",
    "sync-harnesses",
    "sync-shell",
    "write-mcp",
  ])
    expect(text).toContain(`  ${c}`);
  expect(text).toContain("wagglebot.username");
  expect(text).not.toContain("wagglebot.harnesses");
});

test("command help names what the command reads and writes", () => {
  const sync = helpText("sync-agents");
  expect(sync).toContain("company/instructions/");
  expect(sync).toContain("~/.claude/CLAUDE.md");
  expect(sync).not.toContain("~/.claude.json");
  const mcp = helpText("write-mcp");
  expect(mcp).toContain("registry.yaml");
  expect(mcp).toContain("~/.claude.json");
  expect(mcp).toContain("~/.codex/config.toml");
  expect(mcp).toContain("~/.gemini/settings.json");
  expect(mcp).toContain("~/.copilot/mcp-config.json");
  expect(mcp).toContain("~/.cline/data/settings/cline_mcp_settings.json");
  expect(mcp).toContain("~/.junie/mcp/mcp.json");
  const shell = helpText("sync-shell");
  expect(shell).toContain("~/.zshenv");
  expect(shell).toContain(".env.credentials");
  const update = helpText("update");
  expect(update).toContain("~/.zshenv");
  expect(update).toContain("~/.claude/agents/");
});

test("general help hides compatibility aliases and alias help names the project files", () => {
  const text = helpText();
  expect(text).not.toContain("sync-project");
  expect(text).not.toContain("sync-agents");
  const sync = helpText("sync-project");
  expect(sync).toContain(".agents/instructions/");
  expect(sync).toContain("AGENTS.md");
  expect(sync).toContain("CLAUDE.md");
  expect(sync).toContain(".github/copilot-instructions.md");
});

test("public help describes project and cached workflows without internal runtime options", () => {
  for (const command of [undefined, "init", "update", "install-skills", "sync-harnesses"]) {
    const text = helpText(command);
    for (const hidden of ["--company-root", "--pinned-runtime", "--source-failed", "--skip-self-update"])
      expect(text).not.toContain(hidden);
    expect(text).toContain("--wagglebot");
  }
  expect(helpText("init")).toContain(".agents/memory.md");
  expect(helpText("update")).toContain("working tree");
  expect(helpText("update")).toContain("--overwrite-local");
  expect(helpText()).toContain("Phase 2");
});

test("overwrite help identifies the complete replacement scope and authorization", () => {
  const text = helpText("update");
  for (const fragment of [
    "~/.codex/AGENTS.md",
    "~/.cursor/rules/wagglebot.mdc",
    "~/.config/devin/AGENTS.md",
    "~/.codeium/windsurf/memories/global_rules.md",
    "~/.kiro/steering/AGENTS.md",
    "--agent windsurf",
    "--agent kiro-cli",
    "~/.kiro/agents/",
    "~/.gemini/settings.json",
    "~/.copilot/hooks/wagglebot.json",
    "~/.kiro/hooks/wagglebot.json",
    "hooks",
    "~/.codex/config.toml",
    "mcp_servers",
    "mcpServers",
    "no backup",
    "no confirmation",
  ])
    expect(text).toContain(fragment);
});

test("unknown command help falls back to the general text", () => {
  expect(helpText("nope")).toBe(helpText());
});

test("brain help describes local memory and status", () => {
  const text = helpText("brain");
  expect(text).toContain(".agents/memory.md");
  expect(text).toContain("brain remember");
  expect(text).toContain("--json");
});
