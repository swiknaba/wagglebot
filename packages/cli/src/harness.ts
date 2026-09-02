import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One entry per agent harness (provider) that wagglebot provisions. Every path is relative
// to the home directory. This table is the single place that knows where each provider reads
// its files, so an engineer never has to: wagglebot writes the same content to every location,
// and switching providers costs nothing.
export type Harness = {
  name: string;
  // Global instruction files. The rendered base prompt lands in a managed block in each one.
  templateTargets: string[];
  // Settings file that holds hook definitions, plus the fragment in templates/hooks/ to merge.
  hooksTarget?: { path: string; fragmentFile: string };
  // Config file and the key under which MCP servers are declared.
  mcpTarget?: { path: string; parentKey: string };
  // Directory the provider reads custom subagents from. Undefined means the provider has no
  // known subagent format yet: install-agents skips it with one log line (research list R2).
  subagentDir?: string;
};

export const HARNESSES: Harness[] = [
  {
    // Anthropic Claude Code. The only provider with a documented global subagent directory so far.
    name: "claude-code",
    templateTargets: [".claude/CLAUDE.md"],
    hooksTarget: { path: ".claude/settings.json", fragmentFile: "claude-code.json" },
    mcpTarget: { path: ".claude.json", parentKey: "mcpServers" },
    subagentDir: ".claude/agents",
  },
  // OpenAI Codex CLI reads the AGENTS.md convention from its own config directory.
  { name: "codex", templateTargets: [".codex/AGENTS.md"] },
  // JetBrains Junie reads both file names; write both so either lookup finds the prompt.
  { name: "junie", templateTargets: [".junie/AGENTS.md", ".junie/CLAUDE.md"] },
  // Cline keeps global rules in a rules directory and a separate custom-instructions file.
  { name: "cline", templateTargets: [".cline/rules/global.md", ".cline/custom_instructions.md"] },
  // The provider-neutral AGENTS.md convention (agents.md). Tools that follow it, and have no
  // config directory of their own, look here.
  { name: "agents-standard", templateTargets: [".agents/AGENTS.md"] },
  // Google Gemini CLI and Antigravity share the .gemini config directory.
  { name: "gemini", templateTargets: [".gemini/config/GEMINI.md", ".gemini/config/rules/global.md"] },
];

// dist/index.js sits next to templates/ in the published package; src/ sits one level deeper in the repo.
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates");
}
