import { join } from "node:path";
import { startBackupSet } from "../backup";
import { loadCatalog, teamsOf } from "../catalog";
import { findCompanyRoot, loadCompanyRepo } from "../company";
import type { Exec } from "../exec";
import type { Ask } from "../identity";
import { getUsername } from "../identity";
import { resolvePaths } from "../paths";
import { loadRegistry, mergeRegistries } from "../registry";
import type { Reporter } from "../report";
import { runInstallAgents } from "./install-agents";
import { runInstallSkills } from "./install-skills";
import { runSyncAgents } from "./sync-agents";
import { runWriteMcp } from "./write-mcp";

export async function runUpdate(deps: {
  cwd: string;
  home: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
  write: (line: string) => void;
  skillsBin: string;
  skipSelfUpdate?: boolean;
}): Promise<number> {
  const { exec, reporter, write } = deps;
  const root = findCompanyRoot(deps.cwd);
  const pinBefore = loadCompanyRepo(root).pin;

  const pull = await exec("git", ["pull", "--ff-only"], { cwd: root });
  if (pull.code !== 0) {
    reporter.item("git pull --ff-only", "failed", pull.stderr.split("\n")[0] ?? "");
    write(reporter.summary());
    return 1;
  }

  const company = loadCompanyRepo(root);
  if (company.pin !== pinBefore && deps.skipSelfUpdate !== true) {
    write(`wagglebot pin moved ${pinBefore} -> ${company.pin}; running yarn install`);
    const install = await exec("yarn", ["install"], { cwd: root });
    if (install.code !== 0) {
      reporter.item("yarn install", "failed", install.stderr.split("\n")[0] ?? "");
      return 1;
    }
    const rerun = await exec("yarn", ["wagglebot", "update", "--skip-self-update"], { cwd: root });
    write(rerun.stdout);
    return rerun.code;
  }

  const catalog = loadCatalog(company.catalogText, company.catalogPath);
  const username = await getUsername(exec, deps.ask, catalog);
  const teams = teamsOf(catalog, username);

  // One backup set for the whole update, so `sync-agents --restore` restores everything this
  // run touched instead of only whichever command happened to run last.
  const backups = startBackupSet(resolvePaths(deps.home).backupsDir);

  await runInstallSkills({
    listText: company.skillsListText,
    listPath: join(root, "skills.list"),
    exec,
    reporter,
    skillsBin: deps.skillsBin,
  });
  await runInstallAgents({
    home: deps.home,
    listTexts: company.agentListTexts(teams),
    companyAgentsDir: company.agentsDir,
    exec,
    reporter,
    backups,
  });
  runSyncAgents({ home: deps.home, instructionsDir: company.instructionsDir, reporter, backups });

  const base =
    company.registryBaseText === undefined ? [] : loadRegistry(company.registryBaseText, "registry.base.yaml");
  const merged = teams.reduce((acc, team) => {
    const text = company.registryTeamText(team);
    return text === undefined ? acc : mergeRegistries(acc, loadRegistry(text, `registry.team.${team}.yaml`));
  }, base);
  runWriteMcp({ home: deps.home, proxies: merged, reporter, backups });

  write(reporter.summary());
  return reporter.failed() ? 1 : 0;
}
