import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One entry per agent harness (provider) that wagglebot provisions. Every path is relative
// to the home directory. This table is the single place that knows where each provider reads
// its files, so an engineer never has to: wagglebot writes the same content to every location,
// and switching providers costs nothing.
export type Harness = {
  name: string;
  // Home-relative directory whose presence means the harness is installed on this machine.
  detectDir: string;
  // The --agent id the skills CLI uses for this harness. Undefined: the skills CLI has no adapter.
  skillsAgent?: string;
  // Global instruction files. The rendered base prompt lands in a managed block in each one.
  templateTargets: string[];
  // Settings file that holds hook definitions, plus the fragment in templates/hooks/ to merge.
  hooksTarget?: { path: string; fragmentFile: string };
  // Config file that declares the MCP servers, and the dialect that harness reads.
  mcpTarget?: McpTarget;
  // Directory the harness reads Markdown subagents from. Undefined: no known Markdown format.
  subagentDir?: string;
  // Repository-level instruction file, relative to the Git root. `sync-project` writes the
  // instructions there. Undefined: the harness reads no project file that wagglebot knows.
  projectTarget?: ProjectTarget;
};

// Which field names and which transport keys one harness expects inside its MCP config.
// docs/harnesses.md holds the vendor table and the source of each path.
export type McpDialect = "claude" | "codex" | "gemini" | "copilot";
export type McpTarget =
  // A JSON file. Ownership is per child key under parentKey, recorded in ~/.wagglebot/managed.json.
  | { format: "json"; path: string; parentKey: string; dialect: McpDialect }
  // A TOML file. Ownership is a "# wagglebot:begin/end" block that holds one [<table>.<namespace>] per server.
  | { format: "toml"; path: string; table: string; dialect: "codex" };

// How one harness reads project instructions. Several harnesses share one file: Codex, Junie,
// and Cline all read the root AGENTS.md, so their entries name the same path and the command
// writes that file once. A harness with its own file either imports AGENTS.md (mode "import",
// one import line inside the managed block) or carries the complete instructions (mode "block").
export type ProjectTarget = {
  path: string;
  mode: "block" | "import";
  // The line that imports the root AGENTS.md, for mode "import".
  importLine?: string;
  // A vendor-documented default budget in bytes. Output above it produces a warning, never an abort.
  warnBytes?: number;
  // A vendor-documented hard limit in bytes. Output above it aborts before the first mutation.
  limitBytes?: number;
};

// Paths verified against vendor documentation on 2026-09-02. Codex subagents are TOML, not
// Markdown, so Codex has no subagentDir. Cline reads every .md file in its rules directory,
// so wagglebot owns one file there instead of a block in a shared file.
export const HARNESSES: Harness[] = [
  {
    name: "claude-code",
    detectDir: ".claude",
    skillsAgent: "claude-code",
    templateTargets: [".claude/CLAUDE.md"],
    hooksTarget: { path: ".claude/settings.json", fragmentFile: "claude-code.json" },
    // Claude Code reads ~/.claude.json and expands ${VAR} in headers and env.
    mcpTarget: { format: "json", path: ".claude.json", parentKey: "mcpServers", dialect: "claude" },
    subagentDir: ".claude/agents",
    projectTarget: { path: "CLAUDE.md", mode: "import", importLine: "@AGENTS.md" },
  },
  {
    name: "codex",
    detectDir: ".codex",
    skillsAgent: "codex",
    templateTargets: [".codex/AGENTS.md"],
    // https://learn.chatgpt.com/docs/extend/mcp?surface=cli and
    // https://learn.chatgpt.com/docs/config-file/config-reference — TOML, and the table name
    // carries an underscore. Codex expands no ${VAR}, so a credential travels as a variable name.
    mcpTarget: { format: "toml", path: ".codex/config.toml", table: "mcp_servers", dialect: "codex" },
    // Codex reads global, root, and nested AGENTS.md files under one default 32 KiB budget.
    projectTarget: { path: "AGENTS.md", mode: "block", warnBytes: 32 * 1024 },
  },
  {
    name: "junie",
    detectDir: ".junie",
    skillsAgent: "junie",
    templateTargets: [".junie/AGENTS.md"],
    subagentDir: ".junie/agents",
    projectTarget: { path: "AGENTS.md", mode: "block" },
  },
  {
    name: "cline",
    detectDir: ".cline",
    skillsAgent: "cline",
    templateTargets: [".cline/rules/wagglebot.md"],
    projectTarget: { path: "AGENTS.md", mode: "block" },
  },
  {
    name: "gemini",
    detectDir: ".gemini",
    skillsAgent: "gemini-cli",
    templateTargets: [".gemini/GEMINI.md"],
    // https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md and
    // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md — mcpServers
    // sits at the top level, and Gemini expands $VAR, ${VAR}, and ${VAR:-default}.
    mcpTarget: { format: "json", path: ".gemini/settings.json", parentKey: "mcpServers", dialect: "gemini" },
    projectTarget: { path: "GEMINI.md", mode: "import", importLine: "@./AGENTS.md" },
  },
  {
    name: "copilot",
    detectDir: ".copilot",
    skillsAgent: "github-copilot",
    templateTargets: [".copilot/copilot-instructions.md"],
    // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers —
    // no documented ${VAR} expansion, so a credentialed entry is skipped. Every entry carries
    // the documented tools: ["*"].
    mcpTarget: { format: "json", path: ".copilot/mcp-config.json", parentKey: "mcpServers", dialect: "copilot" },
    projectTarget: { path: ".github/copilot-instructions.md", mode: "block" },
  },
];

// dist/index.js sits next to templates/ in the published package; src/ sits one level deeper in the repo.
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates");
}
