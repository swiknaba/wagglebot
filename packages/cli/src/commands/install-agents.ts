import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import type { Exec } from "../exec";
import { HARNESSES } from "../harness";
import { parseList } from "../lists";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

export async function runInstallAgents(deps: {
  home: string;
  listTexts: { path: string; text: string }[];
  companyAgentsDir?: string;
  exec: Exec;
  reporter: Reporter;
  backups?: BackupSet;
}): Promise<number> {
  const { home, exec, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  const backups = deps.backups ?? startBackupSet(paths.backupsDir);
  reporter.section("Custom agents");

  const entries = deps.listTexts.flatMap(({ text }) => parseList(text).entries);
  const targets = HARNESSES.filter((h) => h.subagentDir !== undefined);
  for (const h of HARNESSES.filter((x) => x.subagentDir === undefined))
    reporter.item(h.name, "skipped", "no subagent support in Phase 1");

  const produced: string[] = [];
  const failedPrefixes: string[] = [];

  const installFile = (dest: string, content: string): void => {
    produced.push(dest);
    if (existsSync(dest) && readFileSync(dest, "utf8") === content) {
      reporter.item(dest, "ok", "already ok");
      return;
    }
    const fresh = !existsSync(dest);
    writeFileSync(dest, content);
    reporter.item(dest, fresh ? "installed" : "updated");
  };
  for (const entry of entries) {
    if (entry.isUrl === true) {
      reporter.item(entry.raw, "failed", "an agent list accepts owner/repo[@ref] only, not a full git URL");
      continue;
    }
    const prefix = `${entry.repo.replace("/", "__")}__`;
    const cacheDir = join(paths.agentsCacheDir, entry.repo.replace("/", "__"));
    const git = async (...args: string[]) => exec("git", args);
    const materialize = async (): Promise<boolean> => {
      if (!existsSync(cacheDir)) {
        mkdirSync(paths.agentsCacheDir, { recursive: true });
        const clone = await git("clone", `https://github.com/${entry.repo}.git`, cacheDir);
        if (clone.code !== 0) return false;
      } else if (entry.ref !== undefined) {
        const fetch = await git("-C", cacheDir, "fetch", "--tags", "origin");
        if (fetch.code !== 0) return false;
      } else {
        const pull = await git("-C", cacheDir, "pull", "--ff-only");
        if (pull.code !== 0) return false;
      }
      if (entry.ref !== undefined) {
        const co = await git("-C", cacheDir, "checkout", entry.ref);
        if (co.code !== 0) return false;
      }
      return true;
    };
    if (!(await materialize())) {
      reporter.item(entry.raw, "failed", "git sync failed");
      failedPrefixes.push(prefix);
      continue;
    }
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".md"));
    for (const harness of targets) {
      const dir = join(home, harness.subagentDir ?? "");
      mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const dest = join(dir, `${prefix}${file}`);
        const content = readFileSync(join(cacheDir, file), "utf8");
        installFile(dest, content);
      }
    }
  }

  const companyAgentsDir = deps.companyAgentsDir;
  if (companyAgentsDir !== undefined && existsSync(companyAgentsDir)) {
    const files = readdirSync(companyAgentsDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => f.toLowerCase() !== "readme.md")
      .sort();
    for (const harness of targets) {
      const dir = join(home, harness.subagentDir ?? "");
      mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const dest = join(dir, `company__${file}`);
        const content = readFileSync(join(companyAgentsDir, file), "utf8");
        installFile(dest, content);
      }
    }
  }

  // A failed entry (transient git error) must not uninstall its previously installed files —
  // carry them forward as still-produced so the stale sweep below leaves them alone.
  for (const file of state.agentFiles) {
    if (!produced.includes(file) && failedPrefixes.some((prefix) => basename(file).startsWith(prefix))) {
      produced.push(file);
    }
  }

  for (const stale of state.agentFiles.filter((f) => !produced.includes(f) && existsSync(f))) {
    backups.backup(stale);
    rmSync(stale);
    reporter.item(stale, "updated", "removed — no longer listed");
  }
  state.agentFiles = produced;
  saveState(paths.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
