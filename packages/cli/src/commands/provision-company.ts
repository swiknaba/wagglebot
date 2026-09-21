import { join } from "node:path";
import { startBackupSet } from "../backup";
import { findCompanyRoot, loadCompanyRepo } from "../company";
import { resolveCompanyContext } from "../company-context";
import type { Exec } from "../exec";
import { HARNESSES } from "../harness";
import type { Ask } from "../identity";
import { resolvePaths } from "../paths";
import type { ProxyConfig } from "../registry";
import { loadRegistry, mergeRegistries } from "../registry";
import type { Reporter } from "../report";
import { resolveSkillLockFile } from "../skill-lock";
import { runInstallAgents } from "./install-agents";
import { runInstallSkills } from "./install-skills";
import { runSyncHarnesses } from "./sync-harnesses";
import { runSyncShell } from "./sync-shell";
import { runWriteMcp } from "./write-mcp";

// A pin the run can compare with the running CLI. A range or a "file:" path names no version,
// so wagglebot stays quiet about it.
const EXACT_PIN = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export async function runCompanyProvision(input: {
  companyRoot: string;
  home: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
  write: (line: string) => void;
  skillsBin?: string;
  env?: NodeJS.ProcessEnv;
  overwriteLocal?: boolean;
  sourceFailed?: boolean;
  shellScriptPath?: string;
}): Promise<number> {
  const { reporter } = input;
  let failed = input.sourceFailed === true;
  if (input.sourceFailed)
    reporter.item("Company source", "failed", "The source refresh failed. This run uses the cached company.");
  const stage = async (name: string, run: () => number | Promise<number>): Promise<void> => {
    const before = reporter.counts().failed;
    try {
      if ((await run()) !== 0) {
        failed = true;
        if (reporter.counts().failed === before && before === 0)
          reporter.item(name, "failed", "The stage returned a failure.");
      }
    } catch (error) {
      failed = true;
      reporter.item(name, "failed", error instanceof Error ? error.message : String(error));
    }
  };
  try {
    const { company, layers, catalogFailed } = await resolveCompanyContext({
      root: input.companyRoot,
      exec: input.exec,
      ask: input.ask,
      reporter,
    });
    failed ||= catalogFailed;
    const paths = resolvePaths(input.home);
    const backups = input.overwriteLocal ? undefined : startBackupSet(paths.backupsDir);
    const env = input.env ?? process.env;

    // Each harness has an independent failure boundary and retains the shared state of other harnesses.
    for (const harness of HARNESSES) {
      await stage(`Skills (${harness.name})`, () =>
        runInstallSkills({
          lists: layers.flatMap((layer) =>
            layer.skillsListText === undefined
              ? []
              : [{ path: join(layer.dir, "skills.list"), text: layer.skillsListText }],
          ),
          exec: input.exec,
          reporter,
          skillsBin: input.skillsBin,
          skillsAgents: harness.skillsAgents,
          managedFile: paths.managedFile,
          skillLockFile: resolveSkillLockFile(input.home),
          organization: company.organization,
          overwriteLocal: input.overwriteLocal,
        }),
      );
    }
    for (const harness of HARNESSES) {
      await stage(`Custom agents (${harness.name})`, () =>
        runInstallAgents({
          home: input.home,
          harnesses: [harness],
          listTexts: layers.flatMap((layer) =>
            layer.agentsListText === undefined
              ? []
              : [{ path: join(layer.dir, "agents.list"), text: layer.agentsListText }],
          ),
          agentDirs: layers.map((layer) => ({ prefix: `${layer.name}__`, dir: layer.agentsDir })),
          exec: input.exec,
          reporter,
          organization: company.organization,
          backups,
          overwriteLocal: input.overwriteLocal,
        }),
      );
    }
    for (const harness of HARNESSES) {
      await stage(`Instructions and hooks (${harness.name})`, () =>
        runSyncHarnesses({
          home: input.home,
          harnesses: [harness],
          instructionDirs: layers.map((layer) => layer.instructionsDir),
          reporter,
          backups,
          overwriteLocal: input.overwriteLocal,
        }),
      );
    }
    await stage("Shell environment", () =>
      runSyncShell({
        home: input.home,
        companyRoot: input.companyRoot,
        shellScriptPath: input.shellScriptPath,
        reporter,
        backups: input.overwriteLocal ? false : backups,
        env,
      }),
    );
    await stage("MCP configs", async () => {
      const proxies = layers
        .filter((layer) => layer.registryText !== undefined)
        .reduce<ProxyConfig[]>(
          (acc, layer) =>
            mergeRegistries(acc, loadRegistry(layer.registryText ?? "", join(layer.dir, "registry.yaml"))),
          [],
        );
      for (const harness of HARNESSES) {
        await stage(`MCP configs (${harness.name})`, () =>
          runWriteMcp({
            home: input.home,
            harnesses: [harness],
            proxies,
            env,
            reporter,
            backups,
            overwrite: input.overwriteLocal,
          }),
        );
      }
      return 0;
    });
  } catch (error) {
    reporter.item("Company context", "failed", error instanceof Error ? error.message : String(error));
    failed = true;
  }
  input.write(reporter.summary(true));
  return failed || reporter.failed() ? 1 : 0;
}

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
    write(reporter.summary(true));
    return 1;
  }

  const company = loadCompanyRepo(root);
  // True when the missing-yarn branch already named the pin and the remedy this run.
  let reportedStale = false;
  if (company.pin !== pinBefore && deps.skipSelfUpdate !== true) {
    const install = await exec("yarn", ["install"], { cwd: root });
    const moved = `wagglebot pin moved ${pinBefore} -> ${company.pin}`;
    if (install.notFound === true) {
      // yarn itself is missing. The installers below still run, with the CLI that is installed
      // now (spec: a missing dependency warns and continues). A yarn that exits 127 is a failure.
      reporter.item(
        "yarn install",
        "skipped",
        `yarn is not installed. The pin moved to ${company.pin}, but this run keeps the current CLI. Install yarn, run "yarn install" in the company repository, then run wagglebot update again.`,
      );
      reportedStale = true;
    } else if (install.code !== 0) {
      write(moved);
      reporter.item("yarn install", "failed", install.stderr.split("\n")[0] ?? "");
      write(reporter.summary(true));
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

  return runCompanyProvision({
    companyRoot: root,
    home: deps.home,
    exec,
    ask: deps.ask,
    reporter,
    write,
    skillsBin: deps.skillsBin,
    env,
  });
}
