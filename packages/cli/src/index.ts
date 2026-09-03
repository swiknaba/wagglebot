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
import { runSyncShell } from "./commands/sync-shell";
import { runUpdate } from "./commands/update";
import { runWriteMcp } from "./commands/write-mcp";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "./company";
import type { Exec } from "./exec";
import { realExec } from "./exec";
import { selectAndAnnounce } from "./harness-select";
import { helpText } from "./help";
import type { Ask } from "./identity";
import { getUsername } from "./identity";
import { resolvePaths } from "./paths";
import type { ProxyConfig } from "./registry";
import { loadRegistry, mergeRegistries } from "./registry";
import { createReporter } from "./report";
import { resolveSkillLockFile } from "./skill-lock";

export type CliDeps = { write: (line: string) => void; cwd?: string };

const KNOWN_COMMANDS = ["update", "init", "install-skills", "install-agents", "sync-agents", "sync-shell", "write-mcp"];

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
  const catalog = loadCatalog(company.catalogText, company.catalogPath);
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
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = await selectAndAnnounce(home, exec, deps.write);
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
        skillsAgents: harnesses.flatMap((h) => (h.skillsAgent ? [h.skillsAgent] : [])),
        managedFile: resolvePaths(home).managedFile,
        skillLockFile: resolveSkillLockFile(home),
        update: values.update === true,
        writeList: values.update === true ? (path, text) => writeFileSync(path, text) : undefined,
      });
      deps.write(reporter.summary());
      return code;
    }

    if (command === "install-agents") {
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = await selectAndAnnounce(home, exec, deps.write);
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
      const harnesses = await selectAndAnnounce(home, exec, deps.write);
      const code = runSyncAgents({
        home,
        harnesses,
        instructionDirs: company.layersFor(teams).map((l) => l.instructionsDir),
        reporter,
        options: { dryRun: values["dry-run"] === true },
      });
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
      const { values } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" } } });
      const { company, teams } = await companyContext(cwd, exec, ask);
      const harnesses = await selectAndAnnounce(home, exec, deps.write);
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
        dryRun: values["dry-run"] === true,
      });
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
