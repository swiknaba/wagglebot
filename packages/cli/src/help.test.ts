import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { helpText } from "./help";

const repositoryFile = (...parts: string[]) => join(import.meta.dir, "../../..", ...parts);
const readDocumentation = (...parts: string[]) => {
  const path = repositoryFile(...parts);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
};

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

test("package metadata and Phase 1 documentation keep reserved defaults safe", () => {
  const metadata = JSON.parse(readDocumentation("packages", "cli", "package.json")) as {
    wagglebot?: { companyRepository?: string };
  };
  expect(metadata.wagglebot?.companyRepository).toBe("git@company.example:platform/mycompany-wagglebot.git");

  const onboarding = readDocumentation("docs", "phase-1-onboarding.md");
  expect(onboarding).toContain("npm install --global wagglebot@<version>");
  expect(onboarding).toContain("wagglebot connect <company-git-url>");
  expect(onboarding).toContain("wagglebot update --wagglebot");
  expect(onboarding).toContain("wagglebot init");
  expect(onboarding).toContain("wagglebot update");
  expect(onboarding).toContain("wagglebot init --wagglebot mycompany-wagglebot");
  expect(onboarding).toContain("git init");
  expect(onboarding).toContain("uncommitted working-tree changes");
  expect(onboarding).toContain("reserved");
  expect(onboarding).toContain("never fetches");
  expect(onboarding).toContain("Native Windows");
  expect(onboarding).toContain("unsupported");
});

test("primary and scaffold Phase 1 documentation excludes obsolete workstation setup", () => {
  for (const path of [
    ["README.md"],
    ["packages", "cli", "README.md"],
    ["docs", "phase-1-onboarding.md"],
    ["test-app", "README.md"],
    ["packages", "cli", "templates", "init", "README.md"],
  ]) {
    const text = readDocumentation(...path);
    expect(text).not.toContain("git clone <company repo>");
    expect(text).not.toContain("git clone <this repo>");
    expect(text).not.toContain("yarn update:wagglebot");
    expect(text).not.toContain("wagglebot.harnesses");
    expect(text).not.toContain("harness whose directory exists");
  }
});

test("administrator documentation initializes a Git repository before update", () => {
  for (const path of [
    ["packages", "cli", "README.md"],
    ["docs", "phase-1-onboarding.md"],
    ["test-app", "README.md"],
    ["packages", "cli", "templates", "init", "README.md"],
  ]) {
    const text = readDocumentation(...path);
    expect(text).toContain("wagglebot init --wagglebot mycompany-wagglebot");
    expect(text).toContain("cd mycompany-wagglebot");
    expect(text).toContain("git init");
    const administrator = text.slice(text.indexOf("wagglebot init --wagglebot mycompany-wagglebot"));
    expect(administrator.indexOf("git init")).toBeGreaterThan(administrator.indexOf("cd mycompany-wagglebot"));
    expect(administrator.indexOf("wagglebot update")).toBeGreaterThan(administrator.indexOf("git init"));
  }
  expect(readDocumentation("packages", "cli", "README.md")).toContain(
    "https://github.com/swiknaba/wagglebot/blob/main/docs/phase-1-onboarding.md",
  );
});
