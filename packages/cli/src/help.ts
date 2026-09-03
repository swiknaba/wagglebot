import { SHELL_RC_FILES } from "./commands/sync-shell";
import { HARNESSES } from "./harness";
import { HARNESS_CONFIG_KEY } from "./harness-select";

type Section = { title: string; purpose: string; reads: string[]; writes: string[]; flags?: string[] };

const templateFiles = () =>
  HARNESSES.flatMap((h) => h.templateTargets.map((t) => `~/${t}  (${h.name}, managed block)`));
const hookFiles = () =>
  HARNESSES.flatMap((h) => (h.hooksTarget ? [`~/${h.hooksTarget.path}  (${h.name}, managed hook entries)`] : []));
const mcpFiles = () =>
  HARNESSES.flatMap((h) =>
    h.mcpTarget ? [`~/${h.mcpTarget.path}  (${h.name}, managed keys under ${h.mcpTarget.parentKey})`] : [],
  );
const subagentDirs = () =>
  HARNESSES.flatMap((h) =>
    h.subagentDir ? [`~/${h.subagentDir}/  (${h.name}, files prefixed company__, <team>__, or owner__repo__)`] : [],
  );
const shellFiles = () =>
  SHELL_RC_FILES.map((f) => `~/${f.file}  (managed block${f.createIfMissing ? "" : ", only when the file exists"})`);
const skillDirs = () =>
  HARNESSES.flatMap((h) =>
    h.skillsAgent
      ? [`the global skills directory of ${h.name}  (written by the skills CLI, --agent ${h.skillsAgent})`]
      : [],
  );

const LAYERS = "company/ and teams/<team>/ for each team of the engineer";

const SECTIONS: Record<string, Section> = {
  "install-skills": {
    title: "install-skills",
    purpose:
      "Syncs every entry of the curated skills lists with the skills CLI, into the selected harnesses. Each run installs the skills that are new in a listed repository, and removes each skill that the repository deleted or that no list names any more.",
    reads: [
      `skills.list in ${LAYERS}`,
      "~/.agents/.skill-lock.json  (the lock file of the skills CLI: which skill came from which source)",
    ],
    writes: [...skillDirs(), "~/.wagglebot/managed.json  (which entry was installed for which harness)"],
    flags: ["--update    Bump each pinned entry to the highest version tag on its remote and rewrite the list."],
  },
  "install-agents": {
    title: "install-agents",
    purpose:
      "Installs the shared Markdown subagents: company/agents/, teams/<team>/agents/, and every repository in the agents lists.",
    reads: [`agents/*.md and agents.list in ${LAYERS}`, "~/.wagglebot/agents-cache/  (clones of listed repositories)"],
    writes: [...subagentDirs(), "~/.wagglebot/managed.json  (every subagent file it wrote)"],
  },
  "sync-agents": {
    title: "sync-agents",
    purpose:
      "Writes the base prompt plus the company and team instructions into the global instruction file of each selected harness, and merges the hook fragments.",
    reads: [
      "the base prompt shipped in the wagglebot package",
      `company/instructions/*.md, then teams/<team>/instructions/*.md`,
    ],
    writes: [...templateFiles(), ...hookFiles()],
    flags: ["--restore [~/path]   Write the newest backup set back (every file, or one file)."],
  },
  "sync-shell": {
    title: "sync-shell",
    purpose:
      "Adds a managed block to the shell startup files that loads .env.credentials from the company repository into every new shell.",
    reads: [".env.credentials  (at shell start, never by wagglebot itself)"],
    writes: shellFiles(),
  },
  "write-mcp": {
    title: "write-mcp",
    purpose:
      "Writes the merged MCP registry into the MCP config of each selected harness. Credentials appear as ${VAR} only.",
    reads: [`registry.yaml in ${LAYERS}  (a team entry with the same namespace wins)`],
    writes: [...mcpFiles(), "~/.wagglebot/managed.json  (every key it wrote)"],
  },
  init: {
    title: "init [dir]",
    purpose: "Scaffolds a new company repository. Refuses a directory that is not empty.",
    reads: [],
    writes: ["package.json, README.md, company/, teams/team-payments/, and the example files"],
  },
};

const render = (s: Section): string[] => [
  `wagglebot ${s.title}`,
  "",
  s.purpose,
  "",
  ...(s.reads.length > 0 ? ["Reads:", ...s.reads.map((r) => `  ${r}`), ""] : []),
  "Writes:",
  ...s.writes.map((w) => `  ${w}`),
  ...(s.flags ? ["", "Flags:", ...s.flags.map((f) => `  ${f}`)] : []),
];

const GENERAL = (): string[] => [
  "wagglebot — one AI agent setup for a whole engineering team.",
  "",
  "Usage: wagglebot <command> [options]",
  "",
  "Commands:",
  "  update             Pull the company repository, then run every installer below.",
  "  init [dir]         Scaffold a new company repository.",
  "  install-skills     Install the curated skills lists.",
  "  install-agents     Install the shared subagents.",
  "  sync-agents        Write the base prompt and instructions into every selected harness.",
  "  sync-shell         Load .env.credentials into new shells.",
  "  write-mcp          Write MCP server configs from the registry.",
  "",
  "Options:",
  "  --version          Print the wagglebot version.",
  "  --help             Print this help. `wagglebot <command> --help` describes one command.",
  "",
  "Workstation settings (global git config):",
  "  wagglebot.username    The company Git username. Asked once, then stored. Must be a User in the catalog.",
  `  ${HARNESS_CONFIG_KEY}   Comma-separated harness names to provision. Default: every harness whose`,
  `                        directory exists under ~. Valid: ${HARNESSES.map((h) => h.name).join(", ")}.`,
  "",
  "Every mutation lands inside a managed block (<!-- wagglebot:begin --> in Markdown, # wagglebot:begin",
  "in shell files, recorded keys in JSON). Content outside stays untouched. Changed files are backed up",
  "to ~/.wagglebot/backups/<timestamp>/ first. Restore with `wagglebot sync-agents --restore`.",
];

export function helpText(command?: string): string {
  if (command === "update") {
    const all = ["install-skills", "install-agents", "sync-agents", "sync-shell", "write-mcp"].map((c) => SECTIONS[c]);
    return [
      "wagglebot update",
      "",
      "1. git pull --ff-only in the company repository.",
      "2. yarn install, when the wagglebot pin in package.json moved, then re-run itself.",
      "3. Run every installer, in this order:",
      "",
      ...all.flatMap((s) => (s ? [...render(s), ""] : [])),
      "Flags:",
      "  --skip-self-update   Internal. Set by the re-run after a pin move.",
    ].join("\n");
  }
  const section = command === undefined ? undefined : SECTIONS[command];
  if (section !== undefined) return render(section).join("\n");
  return GENERAL().join("\n");
}
