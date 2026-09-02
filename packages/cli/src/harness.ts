import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Harness = {
  name: string;
  templateTargets: string[];
  hooksTarget?: { path: string; fragmentFile: string };
  mcpTarget?: { path: string; parentKey: string };
  subagentDir?: string;
};

export const HARNESSES: Harness[] = [
  {
    name: "claude-code",
    templateTargets: [".claude/CLAUDE.md"],
    hooksTarget: { path: ".claude/settings.json", fragmentFile: "claude-code.json" },
    mcpTarget: { path: ".claude.json", parentKey: "mcpServers" },
    subagentDir: ".claude/agents",
  },
  { name: "codex", templateTargets: [".codex/AGENTS.md"] },
  { name: "junie", templateTargets: [".junie/AGENTS.md", ".junie/CLAUDE.md"] },
  { name: "cline", templateTargets: [".cline/rules/global.md", ".cline/custom_instructions.md"] },
  { name: "agents-standard", templateTargets: [".agents/AGENTS.md"] },
  { name: "gemini", templateTargets: [".gemini/config/GEMINI.md", ".gemini/config/rules/global.md"] },
];

// dist/index.js sits next to templates/ in the published package; src/ sits one level deeper in the repo.
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates");
}
