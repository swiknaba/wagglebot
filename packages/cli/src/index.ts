import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createLocalBrain, type LocalBrain } from "@wagglebot/local-brain";
import { runBrainInit } from "./commands/brain-init";
import { runBrainRemember } from "./commands/brain-remember";
import { runBrainStatus } from "./commands/brain-status";
import { runInit } from "./commands/company-init";
import { runConnect } from "./commands/connect";
import { runInstallAgents } from "./commands/install-agents";
import { resolveSkillsBin, runInstallSkills } from "./commands/install-skills";
import { runMcpHubApprove } from "./commands/mcp-hub-approve";
import { runProjectInit } from "./commands/project-init";
import { runProjectUpdate } from "./commands/project-update";
import { runCompanyProvision } from "./commands/provision-company";
import { restoreHarnesses, runSyncHarnesses } from "./commands/sync-harnesses";
import { runSyncShell } from "./commands/sync-shell";
import { runWriteMcp } from "./commands/write-mcp";
import { isCompanyRoot } from "./company";
import { isCompanyCacheRoot, refreshCompanyCache, validateCompanyBase } from "./company-cache";
import { resolveCompanyContext } from "./company-context";
import { type PackageMetadata, resolveCompanyRepositoryUrl } from "./company-url";
import type { Exec } from "./exec";
import { realExec } from "./exec";
import { HARNESSES, templatesDir } from "./harness";
import { helpText } from "./help";
import type { Ask } from "./identity";
import { resolvePaths } from "./paths";
import { ensurePinnedRuntime, interactiveRuntimeExec, type RuntimeExec, runPinnedRuntime } from "./pinned-runtime";
import { findGitRoot } from "./project-root";
import type { ProxyConfig } from "./registry";
import { loadRegistry, mergeRegistries } from "./registry";
import { createReporter } from "./report";
import { resolveSkillLockFile } from "./skill-lock";

export type CliDeps = {
  write: (line: string) => void;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  runtimeExec?: RuntimeExec;
  ask?: Ask;
  skillsBin?: string;
  packageMetadata?: PackageMetadata;
  brain?: LocalBrain;
};

const COMPANY_COMMANDS = [
  "install-skills",
  "install-agents",
  "sync-harnesses",
  "sync-agents",
  "sync-shell",
  "write-mcp",
];

const KNOWN_COMMANDS = [
  "update",
  "init",
  "connect",
  "install-skills",
  "install-agents",
  "sync-agents",
  "sync-harnesses",
  "sync-project",
  "sync-shell",
  "write-mcp",
  "mcp-hub",
  "brain",
];

const packageMetadata = (): PackageMetadata => {
  const require = createRequire(import.meta.url);
  return require("../package.json");
};

function runtimeArguments(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      "company-root": { type: "string" },
      "pinned-runtime": { type: "string" },
      "source-failed": { type: "boolean" },
    },
  });
  const removed = new Set<number>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || !["company-root", "pinned-runtime", "source-failed"].includes(token.name)) continue;
    removed.add(token.index);
    if (token.value !== undefined && !token.inlineValue) removed.add(token.index + 1);
  }
  const root = parsed.values["company-root"];
  const pin = parsed.values["pinned-runtime"];
  if (root !== undefined && (typeof root !== "string" || root.startsWith("-")))
    throw new Error("--company-root requires a path");
  if (pin !== undefined && (typeof pin !== "string" || pin.startsWith("-")))
    throw new Error("--pinned-runtime requires a version");
  if (root === undefined && (pin !== undefined || parsed.values["source-failed"] === true))
    throw new Error("Internal runtime state requires --company-root");
  return {
    argv: argv.filter((_, index) => !removed.has(index)),
    root,
    pin,
    sourceFailed: parsed.values["source-failed"] === true,
  };
}

export async function main(argv: string[], deps: CliDeps = { write: console.log }): Promise<number> {
  let runtime: ReturnType<typeof runtimeArguments>;
  try {
    runtime = runtimeArguments(argv);
  } catch (error) {
    deps.write(`wagglebot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const [command, ...rest] = runtime.argv;
  const metadata = deps.packageMetadata ?? packageMetadata();

  if (command === "--version" || command === "-v") {
    deps.write(metadata.version);
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

  const home = deps.home ?? homedir();
  const exec = deps.exec ?? realExec;
  const env = deps.env ?? process.env;
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask: Ask =
    deps.ask ??
    (async (question) => {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(question);
      rl.close();
      return answer;
    });
  const reporter = createReporter(deps.write);
  const cwd = deps.cwd ?? process.cwd();

  try {
    if (command === "connect") {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      if (positionals.length !== 1 || !positionals[0]?.trim()) throw new Error("Usage: wagglebot connect <git-url>");
      const code = runConnect({ url: positionals[0], configFile: resolvePaths(home).configFile, reporter });
      deps.write(reporter.summary(true));
      return code;
    }

    if (command === "init") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { wagglebot: { type: "boolean" }, "overwrite-local": { type: "boolean" } },
      });
      if (values["overwrite-local"])
        throw new Error("--overwrite-local is invalid in project mode or company scaffold mode");
      if (positionals.length > (values.wagglebot ? 1 : 0))
        throw new Error("Usage: wagglebot init [--wagglebot [directory]]");
      const code = values.wagglebot
        ? runInit({ targetDir: resolve(cwd, positionals[0] ?? "."), version: metadata.version, reporter })
        : runProjectInit({ cwd, reporter });
      deps.write(reporter.summary(true));
      return code;
    }

    if (command === "brain") {
      const brain = deps.brain ?? createLocalBrain();
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

    if (command === "sync-project") {
      const { values } = parseArgs({ args: rest, options: { "overwrite-local": { type: "boolean" } } });
      if (values["overwrite-local"]) throw new Error("--overwrite-local is invalid in project mode");
      const code = runProjectUpdate({ cwd, reporter });
      deps.write(reporter.summary(true));
      return code;
    }

    if (command === "update" || COMPANY_COMMANDS.includes(command)) {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          wagglebot: { type: "boolean" },
          "overwrite-local": { type: "boolean" },
          ...(command === "install-skills" ? { update: { type: "boolean" as const } } : {}),
          ...(["sync-harnesses", "sync-agents"].includes(command) ? { restore: { type: "boolean" as const } } : {}),
        },
      });
      if (positionals.length > (values.restore ? 1 : 0)) throw new Error(`Unexpected argument for ${command}`);
      if (values.restore && values["overwrite-local"])
        throw new Error("--restore cannot be combined with --overwrite-local");
      if (command === "install-skills" && values.update && (values.wagglebot || runtime.root !== undefined))
        throw new Error(
          "Cached company revisions are immutable. Run install-skills --update in a marked company working tree.",
        );
      const paths = resolvePaths(home);
      let companyRoot: string;
      let shellScriptPath: string | undefined;
      let credentialsFile: string | undefined;
      if (runtime.root !== undefined) {
        companyRoot = resolve(cwd, runtime.root);
        const { pin } = validateCompanyBase(companyRoot);
        if (runtime.pin !== undefined && runtime.pin !== pin)
          throw new Error("Pinned runtime does not match the company version");
        shellScriptPath =
          runtime.pin === undefined
            ? join(templatesDir(), "shell/wagglebot.sh")
            : join(paths.runtimeDir, pin, "node_modules/wagglebot/templates/shell/wagglebot.sh");
        credentialsFile = paths.credentialsFile;
      } else if (values.wagglebot) {
        let sourceFailed = false;
        let settleCredentials: (() => boolean) | undefined;
        companyRoot = paths.activeCompanyDir;
        if (command === "update") {
          const config = existsSync(paths.configFile) ? JSON.parse(readFileSync(paths.configFile, "utf8")) : {};
          if (typeof config !== "object" || config === null || Array.isArray(config))
            throw new Error("configuration must be a JSON object");
          const url = resolveCompanyRepositoryUrl({ env, config, packageMetadata: metadata });
          const cache = await refreshCompanyCache({ url, paths, exec });
          companyRoot = cache.root;
          settleCredentials = cache.settleCredentials;
          sourceFailed = cache.refreshFailed;
          if (cache.warning) deps.write(cache.warning);
        } else if (!existsSync(companyRoot)) {
          throw new Error('Run "wagglebot update --wagglebot" first. No active company cache exists.');
        }
        let runtimeExit = 1;
        try {
          const { pin } = validateCompanyBase(companyRoot);
          const pinned = await ensurePinnedRuntime({ pin, runtimeDir: paths.runtimeDir, exec });
          runtimeExit = await runPinnedRuntime({
            runtime: pinned,
            argv: runtime.argv,
            companyRoot,
            sourceFailed,
            exec,
            write: deps.write,
            interactiveExec: deps.runtimeExec ?? interactiveRuntimeExec,
          });
        } finally {
          try {
            if (settleCredentials?.() === false) {
              runtimeExit ||= 1;
              deps.write(
                "Credential migration failed: shell readiness was not confirmed. The prior company cache was restored.",
              );
            }
          } catch {
            runtimeExit ||= 1;
            deps.write("Credential migration failed: shell readiness or cache rollback could not be verified.");
          }
        }
        return runtimeExit;
      } else {
        let root: string | undefined;
        try {
          root = findGitRoot(cwd);
        } catch (error) {
          if (command === "update") throw error;
        }
        if (root === undefined || !isCompanyRoot(root)) {
          if (command !== "update")
            throw new Error(`${command} requires --wagglebot outside a marked company repository`);
          if (values["overwrite-local"]) throw new Error("--overwrite-local is invalid in project mode");
          const code = runProjectUpdate({ cwd, reporter });
          deps.write(reporter.summary(true));
          return code;
        }
        companyRoot = root;
        validateCompanyBase(companyRoot);
        if (isCompanyCacheRoot(companyRoot, paths)) {
          if (command === "install-skills" && values.update)
            throw new Error(
              "Cached company revisions are immutable. Run install-skills --update in a marked company working tree.",
            );
          shellScriptPath = join(templatesDir(), "shell/wagglebot.sh");
          credentialsFile = paths.credentialsFile;
        }
      }
      const overwriteLocal = values["overwrite-local"] === true;
      if (command === "update")
        return await runCompanyProvision({
          companyRoot,
          home,
          exec,
          ask,
          reporter,
          write: deps.write,
          skillsBin: deps.skillsBin ?? resolveSkillsBin(),
          env,
          overwriteLocal,
          sourceFailed: runtime.sourceFailed,
          shellScriptPath,
          credentialsFile,
        });
      if (runtime.sourceFailed)
        reporter.item("Company source", "failed", "The source refresh failed. This run uses the cached company.");
      if (values.restore) {
        const code = restoreHarnesses({ home, reporter, target: positionals[0] });
        deps.write(reporter.summary(true));
        return code;
      }
      if (command === "sync-shell") {
        const code = runSyncShell({
          home,
          companyRoot,
          reporter,
          env,
          backups: overwriteLocal ? false : undefined,
          shellScriptPath,
          credentialsFile,
        });
        deps.write(reporter.summary(true));
        return code;
      }
      const { company, layers, catalogFailed } = await resolveCompanyContext({
        root: companyRoot,
        exec,
        ask,
        reporter,
      });
      const finish = (code: number) => {
        deps.write(reporter.summary(true));
        return code || (catalogFailed || reporter.failed() ? 1 : 0);
      };

      if (command === "install-skills") {
        const harnesses = HARNESSES;
        const lists = layers.flatMap((l) =>
          l.skillsListText === undefined ? [] : [{ path: join(l.dir, "skills.list"), text: l.skillsListText }],
        );
        const code = await runInstallSkills({
          lists,
          exec,
          reporter,
          skillsBin: deps.skillsBin ?? resolveSkillsBin(),
          skillsAgents: harnesses.flatMap((h) => h.skillsAgents),
          managedFile: resolvePaths(home).managedFile,
          skillLockFile: resolveSkillLockFile(home),
          organization: company.organization,
          overwriteLocal,
          update: values.update === true,
          writeList: values.update === true ? (path, text) => writeFileSync(path, text) : undefined,
        });
        return finish(code);
      }

      if (command === "install-agents") {
        const harnesses = HARNESSES;
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
          overwriteLocal,
        });
        return finish(code);
      }

      if (command === "sync-agents" || command === "sync-harnesses") {
        const harnesses = HARNESSES;
        const code = runSyncHarnesses({
          home,
          harnesses,
          instructionDirs: layers.map((l) => l.instructionsDir),
          reporter,
          overwriteLocal,
        });
        return finish(code);
      }

      if (command === "write-mcp") {
        const harnesses = HARNESSES;
        const proxies = layers
          .filter((l) => l.registryText !== undefined)
          .reduce<ProxyConfig[]>(
            (acc, l) => mergeRegistries(acc, loadRegistry(l.registryText ?? "", `${l.name}/registry.yaml`)),
            [],
          );
        const code = runWriteMcp({
          home,
          harnesses,
          proxies,
          env,
          reporter,
          overwrite: overwriteLocal,
        });
        return finish(code);
      }
    }

    if (command === "mcp-hub") {
      const [subcommand, namespace] = rest;
      if (subcommand !== "approve" || !namespace) {
        deps.write("wagglebot mcp-hub: usage: wagglebot mcp-hub approve <namespace>");
        return 2;
      }
      const configPath = env.MCP_HUB_CONFIG_PATH;
      if (!configPath) {
        deps.write("wagglebot mcp-hub: MCP_HUB_CONFIG_PATH is required for local approval");
        return 1;
      }
      return runMcpHubApprove({
        namespace,
        configPath,
        trustPath: env.MCP_HUB_TRUST_PATH ?? join(home, ".wagglebot", "mcp-hub", "registry.trust.json"),
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
