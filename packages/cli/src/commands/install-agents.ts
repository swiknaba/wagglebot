import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import type { Exec } from "../exec";
import type { Harness } from "../harness";
import { type ListEntry, parseList } from "../lists";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { clearManagedAgentFiles, loadState, saveState } from "../state";

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

// The Markdown subagents of one directory, sorted. A README documents the directory. It is not an agent.
// Only a regular file counts: a symbolic link in a cloned repository could point anywhere.
const subagentFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => f.toLowerCase() !== "readme.md")
    .filter((f) => lstatSync(join(dir, f)).isFile())
    .sort();

// Validate every component before a category clear. Symlinks can escape the home directory.
function agentDirectory(home: string, directory: string): string {
  const parts = directory.split(sep);
  const target = resolve(home, directory);
  const child = relative(resolve(home), target);
  if (
    directory.trim() === "" ||
    isAbsolute(directory) ||
    basename(directory) !== "agents" ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    child === "" ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error(`Invalid dedicated agent directory: ${JSON.stringify(directory)}`);
  let current = resolve(home);
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Agent directory is not a regular directory: ${current}`);
    }
  }
  return target;
}

export async function runInstallAgents(deps: {
  home: string;
  harnesses: Harness[];
  listTexts: { path: string; text: string }[];
  agentDirs: { prefix: string; dir: string }[];
  exec: Exec;
  reporter: Reporter;
  organization?: string[];
  backups?: BackupSet;
  overwriteLocal?: boolean;
}): Promise<number> {
  const { home, exec, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  const backups = deps.overwriteLocal ? undefined : (deps.backups ?? startBackupSet(paths.backupsDir));
  reporter.section("Custom agents");

  const parsed = deps.listTexts.map((l) => ({ ...l, ...parseList(l.text, { organization: deps.organization }) }));
  for (const l of parsed) for (const w of l.warnings) reporter.warn(`${l.path}: ${w}`);
  const entries = parsed.flatMap((l) => l.entries);
  let targets: string[];
  try {
    targets = [
      ...new Set(deps.harnesses.flatMap((harness) => harness.subagentDirs.map((dir) => agentDirectory(home, dir)))),
    ];
  } catch (error) {
    reporter.item("subagents", "failed", error instanceof Error ? error.message : String(error));
    return 1;
  }
  const without = deps.harnesses.filter((h) => h.subagentDirs.length === 0).map((h) => h.name);
  if (without.length > 0) {
    reporter.item("subagents", "skipped", `Custom agents are unsupported: ${without.join(", ")}`);
  }
  if (targets.length === 0) return 0;

  if (deps.overwriteLocal) {
    for (const dir of targets) {
      rmSync(dir, { recursive: true, force: true });
      clearManagedAgentFiles(state, [dir]);
      saveState(paths.managedFile, state);
      mkdirSync(dir, { recursive: true });
    }
  }

  const produced: string[] = state.agentFiles.filter((file) => !targets.includes(dirname(file)));
  const failedPrefixes: string[] = [];

  const installFile = (dest: string, content: string): void => {
    const stat = lstatSync(dest, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isFile()) {
      reporter.item(dest, "failed", "The agent target is not a regular file");
      if (state.agentFiles.includes(dest)) produced.push(dest);
      return;
    }
    produced.push(dest);
    const fresh = !existsSync(dest);
    if (!fresh && readFileSync(dest, "utf8") === content) {
      reporter.item(dest, "ok", "already ok");
      return;
    }
    if (!fresh) backups?.backup(dest);
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
    const files = subagentFiles(cacheDir);
    for (const dir of targets) {
      mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const dest = join(dir, `${prefix}${file}`);
        const content = readFileSync(join(cacheDir, file), "utf8");
        installFile(dest, content);
      }
    }
  }

  for (const { prefix, dir: agentsDir } of deps.agentDirs) {
    if (prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0")) {
      reporter.item(agentsDir, "failed", "The agent prefix contains a path separator or a null character");
      continue;
    }
    if (!existsSync(agentsDir)) continue;
    const files = subagentFiles(agentsDir);
    for (const dir of targets) {
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
    backups?.backup(stale);
    rmSync(stale);
    reporter.item(stale, "updated", "removed — no longer listed");
  }
  state.agentFiles = produced;
  saveState(paths.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
