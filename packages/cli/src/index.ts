import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createLocalBrain, type LocalBrain } from "@wagglebot/local-brain";
import type { Catalog } from "./catalog";
import { loadCatalog, teamsOf } from "./catalog";
import { runBrainInit } from "./commands/brain-init";
import { runBrainRemember } from "./commands/brain-remember";
import { runBrainStatus } from "./commands/brain-status";
import { runInit } from "./commands/init";
import { runInstallAgents } from "./commands/install-agents";
import { resolveSkillsBin, runInstallSkills } from "./commands/install-skills";
import { runMcpHubApprove } from "./commands/mcp-hub-approve";
import { runProjectUpdate } from "./commands/project-update";
import { runSyncAgents } from "./commands/sync-agents";
import { runSyncShell } from "./commands/sync-shell";
import { runUpdate } from "./commands/update";
import { runWriteMcp } from "./commands/write-mcp";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "./company";
import type { Exec } from "./exec";
import { realExec } from "./exec";
import { HARNESSES } from "./harness";
import { helpText } from "./help";
import type { Ask } from "./identity";
import { getUsername } from "./identity";
import { resolvePaths } from "./paths";
import type { ProxyConfig } from "./registry";
import { loadRegistry, mergeRegistries } from "./registry";
import { createReporter } from "./report";
import { resolveSkillLockFile } from "./skill-lock";

export type CliDeps = { write: (line: string) => void; cwd?: string; brain?: LocalBrain };

const KNOWN_COMMANDS = [
  "update",
  "init",
  "install-skills",
  "install-agents",
  "sync-agents",
  "sync-project",
  "sync-shell",
  "write-mcp",
  "mcp-hub",
  "brain",
];

const version = (): string => {
  const require = createRequire(import.meta.url);
  const pkg: { version: string } = require("../package.json");
  return pkg.version;
};

async function companyContext(
  cwd: string,
  exec: Exec,
  ask: Ask,
): Promise<{
  company: ReturnType<typeof loadCompanyRepo>;
  catalog: Catalog;
  username: string;
  teams: string[];
}> {
  const root = findCompanyRoot(cwd);
  const company = loadCompanyRepo(root);
  if (company.catalog === undefined)
    throw new Error(`${root} has no catalog.yaml — add teams/<team>/catalog.yaml for each team`);
  const catalog = loadCatalog(company.catalog.text, company.catalog.path);
  assertTeamDirsKnown(
    company,
    catalog.groups.map((g) => g.name),
  );
  const username = await getUsername(exec, ask, catalog, { companyRoot: root });
  const teams = teamsOf(catalog, username);
  return { company, catalog, username, teams };
}

export async function main(argv: string[], deps: CliDeps = { write: console.log }): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--version" || command === "-v") {
    deps.write(version());
    return 0;
  }
  if (command === undefined || command === "--help" || command === "-h") {
    deps.write(helpText());
    return 0;
  }
  if ((rest.includes("--help") || rest.includes("-h")) && KNOWN_COMMANDS.includes(command)) {
    deps.write(helpText(command));
    return 0;
  }

  const home = homedir();
  const exec = realExec;
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask: Ask = async (question) => {
    if (rl === undefined) rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close();
    return answer;
  };
  const reporter = createReporter(deps.write);
  const cwd = deps.cwd ?? process.cwd();
  const brain = deps.brain ?? createLocalBrain();

  try {
    if (command === "update") {
      const { values } = parseArgs({ args: rest, options: { "skip-self-update": { type: "boolean" } } });
      return await runUpdate({
        cwd,
        home,
        exec,
        ask,
        reporter,
        write: deps.write,
        skillsBin: resolveSkillsBin(),
        cliVersion: version(),
        skipSelfUpdate: values["skip-self-update"] === true,
      });
    }

    if (command === "init") {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const targetDir = positionals[0] ?? ".";
      return await runInit({ targetDir, version: version(), reporter });
    }

    if (command === "brain") {
      const [subcommand, ...brainArgs] = rest;
      if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
        deps.write(helpText(subcommand === undefined ? "brain" : "brain"));
        return 0;
      }
      if (subcommand === "init") {
        const { positionals } = parseArgs({ args: brainArgs, allowPositionals: true });
        return await runBrainInit({
          projectPath: positionals[0] ?? cwd,
          brain: brain as unknown as Parameters<typeof runBrainInit>[0]["brain"],
          write: deps.write,
        });
      }
      if (subcommand === "status") {
        const { values, positionals } = parseArgs({
          args: brainArgs,
          allowPositionals: true,
          options: { json: { type: "boolean" } },
        });
        try {
          return await runBrainStatus({
            projectPath: positionals[0] ?? cwd,
            brain,
            json: values.json === true,
            write: deps.write,
          });
        } finally {
          await brain.close();
        }
      }
      if (subcommand === "remember") {
        const { values, positionals } = parseArgs({
          args: brainArgs,
          allowPositionals: true,
          options: {
            section: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            evidence: { type: "string", multiple: true },
            save: { type: "boolean" },
          },
        });
        const evidence = (values.evidence ?? []).map((item) => {
          const separator = item.indexOf(":");
          if (separator < 1) throw new Error("--evidence must use kind:reference");
          return { kind: item.slice(0, separator) as "file", ref: item.slice(separator + 1) };
        });
        if (
          typeof values.section !== "string" ||
          typeof values.title !== "string" ||
          typeof values.summary !== "string" ||
          evidence.length === 0
        ) {
          throw new Error("brain remember requires --section, --title, --summary, and --evidence");
        }
        try {
          return await runBrainRemember({
            projectPath: positionals[0] ?? cwd,
            section: values.section as Parameters<typeof runBrainRemember>[0]["section"],
            title: values.title,
            summary: values.summary,
            evidence,
            save: values.save === true,
            brain: brain as unknown as Parameters<typeof runBrainRemember>[0]["brain"],
            write: deps.write,
          });
        } finally {
          await brain.close();
        }
      }
      deps.write(`wagglebot brain: unknown subcommand "${subcommand}"`);
      return 2;
    }

    if (command === "install-skills") {
      const { values } = parseArgs({ args: rest, options: { update: { type: "boolean" } } });
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = HARNESSES;
      const lists = company
        .layersFor(teams)
        .flatMap((l) =>
          l.skillsListText === undefined ? [] : [{ path: join(l.dir, "skills.list"), text: l.skillsListText }],
        );
      const code = await runInstallSkills({
        lists,
        exec,
        reporter,
        skillsBin: resolveSkillsBin(),
        skillsAgents: harnesses.flatMap((h) => h.skillsAgents),
        managedFile: resolvePaths(home).managedFile,
        skillLockFile: resolveSkillLockFile(home),
        organization: company.organization,
        update: values.update === true,
        writeList: values.update === true ? (path, text) => writeFileSync(path, text) : undefined,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "install-agents") {
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = HARNESSES;
      const layers = company.layersFor(teams);
      const code = await runInstallAgents({
        home,
        harnesses,
        listTexts: layers.flatMap((l) =>
          l.agentsListText === undefined ? [] : [{ path: `${l.name}/agents.list`, text: l.agentsListText }],
        ),
        agentDirs: layers.map((l) => ({ prefix: `${l.name}__`, dir: l.agentsDir })),
        exec,
        reporter,
        organization: company.organization,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "sync-agents") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { restore: { type: "boolean" } },
      });
      if (values.restore === true) {
        const code = runSyncAgents({
          home,
          harnesses: [],
          instructionDirs: [],
          reporter,
          options: { restore: true, restoreTarget: positionals[0] },
        });
        deps.write(reporter.summary());
        return code;
      }
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = HARNESSES;
      const code = runSyncAgents({
        home,
        harnesses,
        instructionDirs: company.layersFor(teams).map((l) => l.instructionsDir),
        reporter,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "sync-project") {
      // A project command: it needs a Git repository only. No company repository, no catalog, no
      // identity, and no harness selection, because the repository is shared by engineers who use
      // different harnesses. Every supported project target is written. Git is the undo.
      parseArgs({ args: rest });
      const code = runProjectUpdate({ cwd, reporter });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "sync-shell") {
      const root = findCompanyRoot(cwd);
      const code = runSyncShell({ home, companyRoot: root, reporter });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "write-mcp") {
      parseArgs({ args: rest });
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = HARNESSES;
      const proxies = company
        .layersFor(teams)
        .filter((l) => l.registryText !== undefined)
        .reduce<ProxyConfig[]>(
          (acc, l) => mergeRegistries(acc, loadRegistry(l.registryText ?? "", `${l.name}/registry.yaml`)),
          [],
        );
      const code = runWriteMcp({
        home,
        harnesses,
        proxies,
        env: process.env,
        reporter,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "mcp-hub") {
      const [subcommand, namespace] = rest;
      if (subcommand !== "approve" || !namespace) {
        deps.write("wagglebot mcp-hub: usage: wagglebot mcp-hub approve <namespace>");
        return 2;
      }
      const configPath = process.env.MCP_HUB_CONFIG_PATH;
      if (!configPath) {
        deps.write("wagglebot mcp-hub: MCP_HUB_CONFIG_PATH is required for local approval");
        return 1;
      }
      return runMcpHubApprove({
        namespace,
        configPath,
        trustPath: process.env.MCP_HUB_TRUST_PATH ?? join(home, ".wagglebot", "mcp-hub", "registry.trust.json"),
        confirm: ask,
        write: deps.write,
      });
    }

    deps.write(`wagglebot: unknown command "${command ?? ""}". Run: wagglebot --help`);
    return 2;
  } catch (error) {
    deps.write(`wagglebot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
