import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Harness = {
  name: string;
  skillsAgents: string[];
  templateTargets: string[];
  hookTargets: HookTarget[];
  mcpTargets: McpTarget[];
  subagentDirs: string[];
  projectTarget?: ProjectTarget;
};

export type HookTarget =
  | { format: "settings-json"; path: string; fragmentFile: string }
  | { format: "owned-json-file"; path: string; fragmentFile: string };

// Which field names and which transport keys one harness expects inside its MCP config.
// docs/harnesses.md holds the vendor table and the source of each path.
export type McpDialect =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "cline"
  | "junie"
  | "cursor"
  | "devin"
  | "windsurf"
  | "kiro";
export type McpTarget =
  // A JSON file. Ownership is per child key under parentKey, recorded in ~/.wagglebot/managed.json.
  | { format: "json"; path: string; parentKey: string; dialect: McpDialect }
  // A TOML file. Ownership is a "# wagglebot:begin/end" block that holds one [<table>.<namespace>] per server.
  | { format: "toml"; path: string; table: string; dialect: "codex" };

// How one harness reads project instructions. Several harnesses share one file: Codex, Junie,
// Cline, Cursor, Devin, and Kiro all read the root AGENTS.md, so their entries name the same
// path and the command writes that file once. A harness with its own file either imports AGENTS.md
// (mode "import", one import line inside the managed block) or carries the complete instructions
// (mode "block").
export type ProjectTarget = {
  path: string;
  mode: "block" | "import";
  importLine?: string;
  warnBytes?: number;
  limitBytes?: number;
};

export const HARNESSES: Harness[] = [
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
];

// dist/index.js sits next to templates/ in the published package; src/ sits one level deeper in the repo.
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates");
}
