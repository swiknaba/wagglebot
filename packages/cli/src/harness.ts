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
  // Config file and the key under which MCP servers are declared.
  mcpTarget?: { path: string; parentKey: string };
  // Directory the harness reads Markdown subagents from. Undefined: no known Markdown format.
  subagentDir?: string;
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
    mcpTarget: { path: ".claude.json", parentKey: "mcpServers" },
    subagentDir: ".claude/agents",
  },
  { name: "codex", detectDir: ".codex", skillsAgent: "codex", templateTargets: [".codex/AGENTS.md"] },
  {
    name: "junie",
    detectDir: ".junie",
    skillsAgent: "junie",
    templateTargets: [".junie/AGENTS.md"],
    subagentDir: ".junie/agents",
  },
  { name: "cline", detectDir: ".cline", skillsAgent: "cline", templateTargets: [".cline/rules/wagglebot.md"] },
  { name: "gemini", detectDir: ".gemini", skillsAgent: "gemini-cli", templateTargets: [".gemini/GEMINI.md"] },
  {
    name: "copilot",
    detectDir: ".copilot",
    skillsAgent: "github-copilot",
    templateTargets: [".copilot/copilot-instructions.md"],
  },
];

// dist/index.js sits next to templates/ in the published package; src/ sits one level deeper in the repo.
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates");
}
