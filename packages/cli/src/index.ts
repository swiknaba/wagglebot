import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { Catalog } from "./catalog";
import { loadCatalog, teamsOf } from "./catalog";
import { runInit } from "./commands/init";
import { runInstallAgents } from "./commands/install-agents";
import { resolveSkillsBin, runInstallSkills } from "./commands/install-skills";
import { runSyncAgents } from "./commands/sync-agents";
import { runUpdate } from "./commands/update";
import { runWriteMcp } from "./commands/write-mcp";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "./company";
import type { Exec } from "./exec";
import { realExec } from "./exec";
import { HARNESSES } from "./harness";
import type { Ask } from "./identity";
import { getUsername } from "./identity";
import type { ProxyConfig } from "./registry";
import { loadRegistry, mergeRegistries } from "./registry";
import { createReporter } from "./report";

export type CliDeps = { write: (line: string) => void; cwd?: string };

const version = (): string => {
  const require = createRequire(import.meta.url);
  const pkg: { version: string } = require("../package.json");
  return pkg.version;
};

function helpText(): string {
  const lines: string[] = [];
  lines.push("wagglebot — one AI agent setup for a whole engineering team.");
  lines.push("");
  lines.push("Usage: wagglebot <command> [options]");
  lines.push("");
  lines.push("Commands:");
  lines.push(
    "  update                 Pull the company repo and reinstall skills, agents, base prompt, and MCP configs.",
  );
  lines.push("  init [dir]             Scaffold a new company repository (default: current directory).");
  lines.push("  install-skills         Install the curated skills list.");
  lines.push("  install-agents         Install the shared subagents from agents/ and the curated list.");
  lines.push("  sync-agents            Sync the base prompt, plus the company instructions, into every harness.");
  lines.push("  write-mcp              Write MCP server configs from the registry into every harness.");
  lines.push("");
  lines.push("Options:");
  lines.push("  --version              Print the wagglebot version.");
  lines.push("  --help                 Print this help.");
  lines.push("");
  lines.push("Every mutation lands inside a managed block, marked by <!-- wagglebot:begin --> and");
  lines.push("<!-- wagglebot:end --> (or the equivalent JSON key set). Content outside that block stays");
  lines.push("untouched. Each run records what it touched in ~/.wagglebot/managed.json, and backs up every");
  lines.push("file it changes to ~/.wagglebot/backups/ first (restore with `sync-agents --restore`).");
  lines.push("");
  lines.push("Files touched, by harness:");
  for (const harness of HARNESSES) {
    lines.push(`  ${harness.name}:`);
    for (const target of harness.templateTargets) lines.push(`    ~/${target}  (base prompt, managed block)`);
    if (harness.hooksTarget !== undefined) lines.push(`    ~/${harness.hooksTarget.path}  (hooks, managed keys)`);
    if (harness.mcpTarget !== undefined) lines.push(`    ~/${harness.mcpTarget.path}  (MCP servers, managed keys)`);
    if (harness.subagentDir !== undefined) lines.push(`    ~/${harness.subagentDir}/  (subagent files)`);
  }
  return lines.join("\n");
}

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
  const catalog = loadCatalog(company.catalogText, company.catalogPath);
  assertTeamDirsKnown(
    company,
    catalog.groups.map((g) => g.name),
  );
  const username = await getUsername(exec, ask, catalog);
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
  if (rest.includes("--help") || rest.includes("-h")) {
    if (
      command === "update" ||
      command === "init" ||
      command === "install-skills" ||
      command === "install-agents" ||
      command === "sync-agents" ||
      command === "write-mcp"
    ) {
      deps.write(helpText());
      return 0;
    }
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
        skipSelfUpdate: values["skip-self-update"] === true,
      });
    }

    if (command === "init") {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const targetDir = positionals[0] ?? ".";
      return await runInit({ targetDir, version: version(), reporter });
    }

    if (command === "install-skills") {
      const { values } = parseArgs({ args: rest, options: { update: { type: "boolean" } } });
      const root = findCompanyRoot(cwd);
      const company = loadCompanyRepo(root);
      const listPath = join(company.company.dir, "skills.list");
      const code = await runInstallSkills({
        listText: company.company.skillsListText,
        listPath,
        exec,
        reporter,
        skillsBin: resolveSkillsBin(),
        update: values.update === true,
        writeList: values.update === true ? (text) => writeFileSync(listPath, text) : undefined,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "install-agents") {
      const { company, teams } = await companyContext(cwd, exec, ask);
      const code = await runInstallAgents({
        home,
        listTexts: company
          .layersFor(teams)
          .flatMap((l) =>
            l.agentsListText === undefined ? [] : [{ path: `${l.name}/agents.list`, text: l.agentsListText }],
          ),
        companyAgentsDir: company.company.agentsDir,
        exec,
        reporter,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "sync-agents") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "dry-run": { type: "boolean" }, restore: { type: "boolean" } },
      });
      let instructionsDir: string | undefined;
      try {
        const root = findCompanyRoot(cwd);
        instructionsDir = loadCompanyRepo(root).company.instructionsDir;
      } catch {
        instructionsDir = undefined;
      }
      const code = runSyncAgents({
        home,
        instructionsDir,
        reporter,
        options: {
          dryRun: values["dry-run"] === true,
          restore: values.restore === true,
          restoreTarget: positionals[0],
        },
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "write-mcp") {
      const { values } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" } } });
      const { company, teams } = await companyContext(cwd, exec, ask);
      const proxies = company
        .layersFor(teams)
        .filter((l) => l.registryText !== undefined)
        .reduce<ProxyConfig[]>(
          (acc, l) => mergeRegistries(acc, loadRegistry(l.registryText ?? "", `${l.name}/registry.yaml`)),
          [],
        );
      const code = runWriteMcp({ home, proxies, reporter, dryRun: values["dry-run"] === true });
      deps.write(reporter.summary());
      return code;
    }

    deps.write(`wagglebot: unknown command "${command ?? ""}". Run: wagglebot --help`);
    return 2;
  } catch (error) {
    deps.write(`wagglebot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
