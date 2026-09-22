import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, templatesDir } from "./harness";

const repositoryFile = (...parts: string[]) => join(import.meta.dir, "../../..", ...parts);

test("the harness table carries the nine verified capability adapters", () => {
  expect(HARNESSES.map((h) => h.name)).toEqual([
    "claude-code",
    "codex",
    "junie",
    "gemini",
    "copilot",
    "cline",
    "cursor",
    "devin",
    "kiro",
  ]);

  expect(HARNESSES).toEqual([
    {
      name: "claude-code",
      skillsAgents: ["claude-code"],
      templateTargets: [".claude/CLAUDE.md"],
      hookTargets: [{ format: "settings-json", path: ".claude/settings.json", fragmentFile: "claude-code.json" }],
      mcpTargets: [{ format: "json", path: ".claude.json", parentKey: "mcpServers", dialect: "claude" }],
      subagentDirs: [".claude/agents"],
      projectTarget: { path: "CLAUDE.md", mode: "import", importLine: "@AGENTS.md" },
    },
    {
      name: "codex",
      skillsAgents: ["codex"],
      templateTargets: [".codex/AGENTS.md"],
      hookTargets: [],
      mcpTargets: [{ format: "toml", path: ".codex/config.toml", table: "mcp_servers", dialect: "codex" }],
      subagentDirs: [],
      projectTarget: { path: "AGENTS.md", mode: "block", warnBytes: 32 * 1024 },
    },
    {
      name: "junie",
      skillsAgents: ["junie"],
      templateTargets: [".junie/AGENTS.md"],
      hookTargets: [],
      mcpTargets: [{ format: "json", path: ".junie/mcp/mcp.json", parentKey: "mcpServers", dialect: "junie" }],
      subagentDirs: [".junie/agents"],
      projectTarget: { path: "AGENTS.md", mode: "block" },
    },
    {
      name: "gemini",
      skillsAgents: ["gemini-cli"],
      templateTargets: [".gemini/GEMINI.md"],
      hookTargets: [{ format: "settings-json", path: ".gemini/settings.json", fragmentFile: "gemini.json" }],
      mcpTargets: [{ format: "json", path: ".gemini/settings.json", parentKey: "mcpServers", dialect: "gemini" }],
      subagentDirs: [".gemini/agents"],
      projectTarget: { path: "GEMINI.md", mode: "import", importLine: "@./AGENTS.md" },
    },
    {
      name: "copilot",
      skillsAgents: ["github-copilot"],
      templateTargets: [".copilot/copilot-instructions.md"],
      hookTargets: [{ format: "owned-json-file", path: ".copilot/hooks/wagglebot.json", fragmentFile: "copilot.json" }],
      mcpTargets: [{ format: "json", path: ".copilot/mcp-config.json", parentKey: "mcpServers", dialect: "copilot" }],
      subagentDirs: [".copilot/agents"],
      projectTarget: { path: ".github/copilot-instructions.md", mode: "block" },
    },
    {
      name: "cline",
      skillsAgents: ["cline"],
      templateTargets: [".cline/rules/wagglebot.md"],
      hookTargets: [],
      mcpTargets: [
        {
          format: "json",
          path: ".cline/data/settings/cline_mcp_settings.json",
          parentKey: "mcpServers",
          dialect: "cline",
        },
      ],
      subagentDirs: [],
      projectTarget: { path: "AGENTS.md", mode: "block" },
    },
    {
      name: "cursor",
      skillsAgents: ["cursor"],
      templateTargets: [".cursor/rules/wagglebot.mdc"],
      hookTargets: [{ format: "owned-json-file", path: ".cursor/hooks.json", fragmentFile: "cursor.json" }],
      mcpTargets: [{ format: "json", path: ".cursor/mcp.json", parentKey: "mcpServers", dialect: "cursor" }],
      subagentDirs: [".cursor/agents"],
      projectTarget: { path: "AGENTS.md", mode: "block" },
    },
    {
      name: "devin",
      skillsAgents: ["devin", "windsurf"],
      templateTargets: [".config/devin/AGENTS.md", ".codeium/windsurf/memories/global_rules.md"],
      hookTargets: [
        { format: "settings-json", path: ".config/devin/config.json", fragmentFile: "devin.json" },
        { format: "owned-json-file", path: ".codeium/windsurf/hooks.json", fragmentFile: "windsurf.json" },
      ],
      mcpTargets: [
        { format: "json", path: ".config/devin/mcp_config.json", parentKey: "mcpServers", dialect: "devin" },
        { format: "json", path: ".codeium/windsurf/mcp_config.json", parentKey: "mcpServers", dialect: "windsurf" },
      ],
      subagentDirs: [".config/devin/agents"],
      projectTarget: { path: "AGENTS.md", mode: "block" },
    },
    {
      name: "kiro",
      skillsAgents: ["kiro-cli"],
      templateTargets: [".kiro/steering/AGENTS.md"],
      hookTargets: [{ format: "owned-json-file", path: ".kiro/hooks/wagglebot.json", fragmentFile: "kiro.json" }],
      mcpTargets: [{ format: "json", path: ".kiro/settings/mcp.json", parentKey: "mcpServers", dialect: "kiro" }],
      subagentDirs: [".kiro/agents"],
      projectTarget: { path: "AGENTS.md", mode: "block" },
    },
  ]);
});

test("shipped template files exist", () => {
  expect(existsSync(join(templatesDir(), "AGENTS.base.md"))).toBe(true);
  expect(existsSync(join(templatesDir(), "hooks", "claude-code.json"))).toBe(true);
});

test("every MCP target is home-relative and names its dialect", () => {
  for (const harness of HARNESSES) {
    for (const target of harness.mcpTargets) {
      expect(target.path.startsWith(".")).toBe(true);
      expect(target.path).not.toContain("~");
      expect(target.dialect.length).toBeGreaterThan(0);
    }
  }
});

test("the harness reference documents all supported local adapters and Devin Desktop targets", () => {
  const path = repositoryFile("docs", "harnesses.md");
  expect(existsSync(path)).toBe(true);
  const text = readFileSync(path, "utf8");

  for (const name of [
    "Claude Code",
    "OpenAI Codex",
    "JetBrains Junie",
    "Gemini CLI",
    "GitHub Copilot",
    "Cline",
    "Cursor",
    "Devin Desktop",
    "Kiro",
  ])
    expect(text).toContain(name);

  for (const harness of HARNESSES) {
    for (const path of harness.templateTargets) expect(text).toContain(`~/${path}`);
    for (const target of harness.hookTargets) expect(text).toContain(`~/${target.path}`);
    for (const target of harness.mcpTargets) expect(text).toContain(`~/${target.path}`);
    for (const path of harness.subagentDirs) expect(text).toContain(`~/${path}`);
    const project = harness.projectTarget;
    if (project !== undefined) {
      expect(text).toContain(`\`${project.path}\``);
      expect(text).toContain(project.mode);
      if (project.importLine !== undefined) expect(text).toContain(project.importLine);
    }
  }

  for (const fragment of [
    "Primary vendor source",
    "local Devin Desktop only",
    "Devin cloud agent",
    "Devin CLI",
    "Cascade",
    ".config/devin/config.json",
    ".codeium/windsurf/hooks.json",
    "mcpServers",
    "mcp_servers",
    "Default mode preserves",
    "foreign `mcpServers` entries",
    "state-owned keys",
    "env_vars",
    "environment-map key",
    "same-name restriction",
    "bearer_token_env_var",
    "env_http_headers",
    "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
    "https://docs.devin.ai/desktop/devin-local",
    "https://docs.devin.ai/cli/extensibility/mcp/configuration",
    "https://docs.devin.ai/desktop/cascade/hooks",
    "https://kiro.dev/docs/mcp/configuration/",
    "httpUrl",
    "streamableHttp",
    "${env:NAME}",
    "${NAME}",
    "PostFileSave",
  ])
    expect(text).toContain(fragment);

  const normalized = text.replace(/\s+/g, " ");
  expect(normalized).not.toContain("Every dialect skips literal or file credential sources.");
});
