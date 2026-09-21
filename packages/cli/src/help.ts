import { PROJECT_INSTRUCTIONS_DIR } from "./commands/project-update";
import { SHELL_RC_FILES } from "./commands/sync-shell";
import { HARNESSES } from "./harness";

type Section = { title: string; purpose: string; reads: string[]; writes: string[]; flags?: string[] };

const templateFiles = () =>
  HARNESSES.flatMap((h) => h.templateTargets.map((t) => `~/${t}  (${h.name}, managed block)`));
const hookFiles = () =>
  HARNESSES.flatMap((h) => h.hookTargets.map((t) => `~/${t.path}  (${h.name}, managed hook entries)`));
const mcpFiles = () =>
  HARNESSES.flatMap((h) => {
    return h.mcpTargets.map((t) => {
      if (t.format === "toml")
        return `~/${t.path}  (${h.name}, managed block, one [${t.table}.<namespace>] table per server)`;
      return `~/${t.path}  (${h.name}, managed keys under ${t.parentKey})`;
    });
  });
const subagentDirs = () =>
  HARNESSES.flatMap((h) =>
    h.subagentDirs.map((dir) => `~/${dir}/  (${h.name}, files prefixed company__, <team>__, or owner__repo__)`),
  );
const projectFiles = () => {
  const byPath = new Map<string, { names: string[]; how: string }>();
  for (const h of HARNESSES) {
    const t = h.projectTarget;
    if (t === undefined) continue;
    const how = t.mode === "import" ? `managed ${t.importLine ?? ""} import` : "managed block";
    const seen = byPath.get(t.path);
    if (seen === undefined) byPath.set(t.path, { names: [h.name], how });
    else seen.names.push(h.name);
  }
  return [...byPath.entries()].map(([path, v]) => `<git root>/${path}  (${v.names.join(", ")}, ${v.how})`);
};
const shellFiles = () =>
  SHELL_RC_FILES.map((f) => `~/${f.file}  (managed block, when the file exists or this machine uses ${f.shell})`);
const skillDirs = () =>
  HARNESSES.flatMap((h) =>
    h.skillsAgents.map(
      (agent) => `the global skills directory of ${h.name}  (written by the skills CLI, --agent ${agent})`,
    ),
  );

const LAYERS = "company/ and teams/<team>/ for each team of the engineer";
const COMPANY_SOURCE =
  "Use the marked company working tree. Elsewhere, use --wagglebot to select the active cache and its exact runtime pin.";
const projectWrites = () => [
  "<git root>/.agents/memory.md  (create only when missing)",
  "<git root>/.agents/changelog.md  (create only when missing)",
  ...projectFiles(),
];

function overwriteScope(command: string): string[] {
  const all = command === "update";
  const targets = [
    ...(all || command === "sync-harnesses"
      ? HARNESSES.flatMap((h) => h.templateTargets.map((path) => `~/${path}  (entire instruction file)`))
      : []),
    ...(all || command === "install-skills" ? skillDirs() : []),
    ...(all || command === "install-agents"
      ? HARNESSES.flatMap((h) => h.subagentDirs.map((path) => `~/${path}/  (entire custom agent directory)`))
      : []),
    ...(all || command === "sync-harnesses"
      ? HARNESSES.flatMap((h) =>
          h.hookTargets.map(
            (target) =>
              `~/${target.path}  (${target.path.endsWith("/wagglebot.json") ? "entire owned hooks file" : "complete hooks category"})`,
          ),
        )
      : []),
    ...(all || command === "write-mcp"
      ? HARNESSES.flatMap((h) =>
          h.mcpTargets.map(
            (target) =>
              `~/${target.path}  (complete ${target.format === "toml" ? target.table : target.parentKey} category)`,
          ),
        )
      : []),
  ];
  return [
    "",
    "Overwrite mode: --overwrite-local",
    "The flag authorizes replacement on this run, with no confirmation and no backup.",
    "Unrelated IDE settings remain unchanged. The shell stage replaces only its managed block.",
    ...(targets.length ? ["Replacement targets:", ...targets.map((target) => `  ${target}`)] : []),
  ];
}

const SECTIONS: Record<string, Section> = {
  "install-skills": {
    title: "install-skills",
    purpose:
      "Installs the curated skills in every compatible harness. Removes only previously managed skills that no effective list names.",
    reads: [
      `skills.list in ${LAYERS}`,
      "~/.agents/.skill-lock.json  (the lock file of the skills CLI: which skill came from which source)",
    ],
    writes: [...skillDirs(), "~/.wagglebot/managed.json  (which entry was installed for which harness)"],
    flags: [
      "--update    Bump each pin to the highest version tag. Requires a marked company working tree. Cached revisions are immutable.",
    ],
  },
  "install-agents": {
    title: "install-agents",
    purpose:
      "Installs the shared Markdown subagents: company/agents/, teams/<team>/agents/, and every repository in the agents lists.",
    reads: [`agents/*.md and agents.list in ${LAYERS}`, "~/.wagglebot/agents-cache/  (clones of listed repositories)"],
    writes: [...subagentDirs(), "~/.wagglebot/managed.json  (every subagent file it wrote)"],
  },
  "sync-harnesses": {
    title: "sync-harnesses",
    purpose:
      "Writes the base, company, and team instructions into each global instruction file. Merges compatible deterministic hooks.",
    reads: [
      "the base prompt shipped in the wagglebot package",
      `company/instructions/*.md, then teams/<team>/instructions/*.md`,
    ],
    writes: [...templateFiles(), ...hookFiles()],
    flags: ["--restore [~/path]   Write the newest backup set back (every file, or one file)."],
  },
  project: {
    title: "update",
    purpose:
      "Publishes sorted project instructions to every supported project target. Preserves personal content outside managed blocks and all existing memory and changelog files. Git provides history and recovery. Requires a Git repository, but no company configuration or identity.",
    reads: [`<git root>/${PROJECT_INSTRUCTIONS_DIR}/*.md  (sorted by name, concatenated)`],
    writes: projectWrites(),
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
      "Writes compatible MCP entries into each harness configuration. Writes safe variable references, never credential values. Skips unsupported transports and credential forms with an explanation.",
    reads: [`registry.yaml in ${LAYERS}  (a team entry with the same namespace wins)`],
    writes: [...mcpFiles(), "~/.wagglebot/managed.json  (every key it wrote)"],
  },
  "mcp-hub": {
    title: "mcp-hub approve <namespace>",
    purpose: "Approves the privileged fields of one validated local MCP hub registry entry.",
    reads: ["MCP_HUB_CONFIG_PATH  (a validated local registry snapshot)"],
    writes: ["~/.wagglebot/mcp-hub/registry.trust.json  (mode 0600 trust records)"],
  },
  init: {
    title: "init [--wagglebot [directory]]",
    purpose:
      "Initializes the current Git project, then performs the first project update. With --wagglebot, scaffolds an empty company directory instead.",
    reads: [],
    writes: [
      "<git root>/.agents/instructions/",
      ...projectWrites(),
      "Company scaffold only: wagglebot.yaml, package.json, README.md, company/, teams/, and example files",
    ],
  },
  connect: {
    title: "connect <git-url>",
    purpose:
      "Stores the company repository URL without Git credentials. Works outside a Git repository. Git uses your existing authentication.",
    reads: [],
    writes: ["~/.wagglebot/config.json  (mode 0600, preserves unrelated settings)"],
  },
  brain: {
    title: "brain <init|remember|status>",
    purpose:
      "Phase 2: Maintains local component memory, CodeGraph, and Git evidence. Phase 1 init and update do not invoke these commands.",
    reads: ["the current Git repository", ".agents/memory.md when it exists"],
    writes: [
      ".agents/memory.md only with brain remember --save",
      ".gitignore with the owned .codegraph/ block",
      ".codegraph/ (generated and ignored)",
    ],
    flags: [
      "init [path]       Create local memory and initialize CodeGraph.",
      "remember [path]   Preview a proposal, or save it with --save.",
      "status [path]     Report local providers. Use --json for typed output.",
    ],
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
  "Phase 1 workflow:",
  "  connect <git-url>   Save the company repository URL. Optional when the package has a real default.",
  "  init               Initialize the current Git project and perform its first update.",
  "  update             Update the project, or provision from a marked company working tree.",
  "  init --wagglebot [directory]   Scaffold a company repository with wagglebot.yaml.",
  "  update --wagglebot  Refresh the company cache and provision with its exact runtime pin.",
  "",
  "Advanced company commands:",
  `  ${COMPANY_SOURCE}`,
  "  install-skills     Install the curated skills lists.",
  "  install-agents     Install the shared subagents.",
  "  sync-harnesses     Write global instructions and compatible hooks.",
  "  sync-shell         Load .env.credentials into new shells.",
  "  write-mcp          Write MCP server configs from the registry.",
  "",
  "Outside the Phase 1 workflow:",
  "  mcp-hub            Approve local MCP hub registry entries.",
  "  Phase 2:",
  "  brain              Maintain local component memory and repository evidence.",
  "",
  "Options:",
  "  --version          Print the wagglebot version.",
  "  --help             Print this help. `wagglebot <command> --help` describes one command.",
  "  --overwrite-local  Replace company-managed categories. See update --help for every target.",
  "",
  "Workstation settings (global git config):",
  "  wagglebot.username    The company Git username. Asked once, then stored. Unknown users receive the company layer.",
  "",
  "Default company updates preserve personal content through owned blocks, entries, files, and installation state.",
  "Changed company targets use ~/.wagglebot/backups/. Restore with wagglebot sync-harnesses --restore.",
  "Overwrite mode creates no backup and requests no confirmation. Project mode rejects --overwrite-local.",
  "Company URLs resolve from WAGGLEBOT_COMPANY_REPOSITORY_URL, saved configuration, then package metadata.",
  "Reserved .example hosts count as unset. Run wagglebot connect when no usable URL exists.",
];

export function helpText(command?: string): string {
  if (command === "sync-project") return render(SECTIONS.project as Section).join("\n");
  if (command === "sync-agents") command = "sync-harnesses";
  if (command === "update") {
    const all = ["install-skills", "install-agents", "sync-harnesses", "sync-shell", "write-mcp"].map(
      (c) => SECTIONS[c],
    );
    return [
      "wagglebot update [--wagglebot] [--overwrite-local]",
      "",
      ...render(SECTIONS.project as Section),
      "",
      "Inside a marked company working tree, use all current files, including uncommitted changes, with the current CLI process.",
      "With --wagglebot, refresh the connected cache, validate its exact pin, and continue with that pinned runtime.",
      "A failed refresh uses a valid stale cache and returns failure after provisioning.",
      "Project mode rejects --overwrite-local.",
      "Company provisioning runs these stages in order:",
      "",
      ...all.flatMap((s) => (s ? [...render(s), ""] : [])),
      ...overwriteScope("update"),
    ].join("\n");
  }
  const section = command === undefined ? undefined : SECTIONS[command];
  if (section !== undefined)
    return [
      ...render(section),
      ...(["install-skills", "install-agents", "sync-harnesses", "sync-shell", "write-mcp"].includes(command ?? "")
        ? ["", COMPANY_SOURCE, ...overwriteScope(command ?? "")]
        : []),
    ].join("\n");
  return GENERAL().join("\n");
}
