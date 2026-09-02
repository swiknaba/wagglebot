import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import type { Exec } from "../exec";
import type { Harness } from "../harness";
import { type ListEntry, parseList } from "../lists";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

// Where to clone an agent list entry from, and the filename prefix that marks its files.
//   owner/repo[@ref]      -> https://github.com/owner/repo.git, prefix owner__repo
//   <clone URL> [ref]     -> the URL itself, prefix from the last two path segments
type AgentSource = { cloneUrl: string; ref?: string; id: string };

export function resolveSource(entry: ListEntry): AgentSource {
  if (entry.isUrl !== true) {
    return { cloneUrl: `https://github.com/${entry.repo}.git`, ref: entry.ref, id: entry.repo.replace("/", "__") };
  }
  const segments = entry.repo
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter((s) => s !== "")
    .slice(-2)
    .map((s) => s.replace(/[^\w.-]/g, "_"));
  return { cloneUrl: entry.repo, ref: entry.ref, id: segments.join("__") };
}

export async function runInstallAgents(deps: {
  home: string;
  harnesses: Harness[];
  listTexts: { path: string; text: string }[];
  agentDirs: { prefix: string; dir: string }[];
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
  const targets = deps.harnesses.filter((h) => h.subagentDir !== undefined);
  const without = deps.harnesses.filter((h) => h.subagentDir === undefined).map((h) => h.name);
  if (without.length > 0) {
    reporter.item("subagents", "skipped", `no Markdown subagent directory: ${without.join(", ")}`);
  }

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
    const source = resolveSource(entry);
    const prefix = `${source.id}__`;
    const cacheDir = join(paths.agentsCacheDir, source.id);
    const git = async (...args: string[]) => exec("git", args);
    const materialize = async (): Promise<boolean> => {
      if (!existsSync(cacheDir)) {
        mkdirSync(paths.agentsCacheDir, { recursive: true });
        const clone = await git("clone", source.cloneUrl, cacheDir);
        if (clone.code !== 0) return false;
      } else if (source.ref !== undefined) {
        const fetch = await git("-C", cacheDir, "fetch", "--tags", "origin");
        if (fetch.code !== 0) return false;
      } else {
        const pull = await git("-C", cacheDir, "pull", "--ff-only");
        if (pull.code !== 0) return false;
      }
      if (source.ref !== undefined) {
        const co = await git("-C", cacheDir, "checkout", source.ref);
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

  for (const { prefix, dir: agentsDir } of deps.agentDirs) {
    if (!existsSync(agentsDir)) continue;
    const files = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => f.toLowerCase() !== "readme.md")
      .sort();
    for (const harness of targets) {
      const dir = join(home, harness.subagentDir ?? "");
      mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const dest = join(dir, `${prefix}${file}`);
        const content = readFileSync(join(agentsDir, file), "utf8");
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
