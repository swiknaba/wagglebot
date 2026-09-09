import { join } from "node:path";
import { startBackupSet } from "../backup";
import { loadCatalog, teamsOf } from "../catalog";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "../company";
import type { Exec } from "../exec";
import { selectAndAnnounce } from "../harness-select";
import type { Ask } from "../identity";
import { getUsername } from "../identity";
import { resolvePaths } from "../paths";
import type { ProxyConfig } from "../registry";
import { loadRegistry, mergeRegistries } from "../registry";
import type { Reporter } from "../report";
import { resolveSkillLockFile } from "../skill-lock";
import { runInstallAgents } from "./install-agents";
import { runInstallSkills } from "./install-skills";
import { runSyncAgents } from "./sync-agents";
import { runSyncShell } from "./sync-shell";
import { runWriteMcp } from "./write-mcp";

// A pin the run can compare with the running CLI. A range or a "file:" path names no version,
// so wagglebot stays quiet about it.
const EXACT_PIN = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export async function runUpdate(deps: {
  cwd: string;
  home: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
  write: (line: string) => void;
  skillsBin: string | undefined;
  // The version of the CLI that runs now. The run compares it with the company pin.
  cliVersion: string;
  skipSelfUpdate?: boolean;
  // The process environment. sync-shell reads $SHELL from it, and write-mcp expands ${VAR}.
  // A test passes its own, so neither step depends on the machine that runs the suite.
  env?: Record<string, string | undefined>;
}): Promise<number> {
  const { exec, reporter, write } = deps;
  const env = deps.env ?? process.env;
  const root = findCompanyRoot(deps.cwd);
  const pinBefore = loadCompanyRepo(root).pin;

  const pull = await exec("git", ["pull", "--ff-only"], { cwd: root });
  if (pull.code !== 0) {
    reporter.item("git pull --ff-only", "failed", pull.stderr.split("\n")[0] ?? "");
    write(reporter.summary());
    return 1;
  }

  const company = loadCompanyRepo(root);
  // True when the missing-yarn branch already named the pin and the remedy this run.
  let reportedStale = false;
  if (company.pin !== pinBefore && deps.skipSelfUpdate !== true) {
    const install = await exec("yarn", ["install"], { cwd: root });
    const moved = `wagglebot pin moved ${pinBefore} -> ${company.pin}`;
    if (install.code === 127) {
      // realExec maps a command that does not exist to 127. The installers below still run, with
      // the CLI that is installed now (spec: a missing dependency warns and continues).
      reporter.item(
        "yarn install",
        "skipped",
        `yarn is not installed. The pin moved to ${company.pin}, but this run keeps the current CLI. Install yarn, run "yarn install" in the company repository, then run wagglebot update again.`,
      );
      reportedStale = true;
    } else if (install.code !== 0) {
      write(moved);
      reporter.item("yarn install", "failed", install.stderr.split("\n")[0] ?? "");
      write(reporter.summary());
      return 1;
    } else {
      write(`${moved}. yarn install updated the CLI.`);
      const rerun = await exec("yarn", ["wagglebot", "update", "--skip-self-update"], { cwd: root });
      write(rerun.stdout);
      return rerun.code;
    }
  }

  // The pin moves once, and the remedy can fail on that run. Report the gap on every later run
  // too, so a stale CLI never provisions a workstation in silence (P35).
  if (!reportedStale && EXACT_PIN.test(company.pin) && company.pin !== deps.cliVersion) {
    reporter.item(
      "wagglebot",
      "skipped",
      `the company pins wagglebot ${company.pin}, but this run uses ${deps.cliVersion} — run "yarn install" in the company repository, then run wagglebot update again`,
    );
  }

  const catalog = loadCatalog(company.catalogText, company.catalogPath);
  assertTeamDirsKnown(
    company,
    catalog.groups.map((g) => g.name),
  );
  const username = await getUsername(exec, deps.ask, catalog, { companyRoot: root });
  const teams = teamsOf(catalog, username);

  const harnesses = await selectAndAnnounce(deps.home, exec, write);

  const layers = company.layersFor(teams);
  const paths = resolvePaths(deps.home);

  // One backup set for the whole update, so `sync-agents --restore` restores everything this
  // run touched instead of only whichever command happened to run last.
  const backups = startBackupSet(paths.backupsDir);

  await runInstallSkills({
    lists: layers.flatMap((l) =>
      l.skillsListText === undefined ? [] : [{ path: join(l.dir, "skills.list"), text: l.skillsListText }],
    ),
    exec,
    reporter,
    skillsBin: deps.skillsBin,
    skillsAgents: harnesses.flatMap((h) => (h.skillsAgent ? [h.skillsAgent] : [])),
    managedFile: paths.managedFile,
    skillLockFile: resolveSkillLockFile(deps.home),
    organization: company.organization,
  });
  await runInstallAgents({
    home: deps.home,
    harnesses,
    listTexts: layers.flatMap((l) =>
      l.agentsListText === undefined ? [] : [{ path: `${l.name}/agents.list`, text: l.agentsListText }],
    ),
    agentDirs: layers.map((l) => ({ prefix: `${l.name}__`, dir: l.agentsDir })),
    exec,
    reporter,
    organization: company.organization,
    backups,
  });
  runSyncAgents({
    home: deps.home,
    harnesses,
    instructionDirs: layers.map((l) => l.instructionsDir),
    reporter,
    backups,
  });
  runSyncShell({ home: deps.home, companyRoot: root, reporter, backups, env });

  const proxies = layers
    .filter((l) => l.registryText !== undefined)
    .reduce<ProxyConfig[]>(
      (acc, l) => mergeRegistries(acc, loadRegistry(l.registryText ?? "", `${l.name}/registry.yaml`)),
      [],
    );
  runWriteMcp({ home: deps.home, harnesses, proxies, env, reporter, backups });

  write(reporter.summary());
  return reporter.failed() ? 1 : 0;
}
