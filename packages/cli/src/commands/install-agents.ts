import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../exec";
import { HARNESSES } from "../harness";
import { parseList } from "../lists";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

export async function runInstallAgents(deps: {
  home: string;
  listTexts: { path: string; text: string }[];
  exec: Exec;
  reporter: Reporter;
}): Promise<number> {
  const { home, exec, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  reporter.section("Custom agents");

  const entries = deps.listTexts.flatMap(({ text }) => parseList(text).entries);
  const targets = HARNESSES.filter((h) => h.subagentDir !== undefined);
  for (const h of HARNESSES.filter((x) => x.subagentDir === undefined))
    reporter.item(h.name, "skipped", "no subagent support in Phase 1 (R2)");

  const produced: string[] = [];
  for (const entry of entries) {
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
      continue;
    }
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".md"));
    for (const harness of targets) {
      const dir = join(home, harness.subagentDir ?? "");
      mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const dest = join(dir, `${entry.repo.replace("/", "__")}__${file}`);
        const content = readFileSync(join(cacheDir, file), "utf8");
        produced.push(dest);
        if (existsSync(dest) && readFileSync(dest, "utf8") === content) {
          reporter.item(dest, "ok", "already ok");
          continue;
        }
        const fresh = !existsSync(dest);
        writeFileSync(dest, content);
        reporter.item(dest, fresh ? "installed" : "updated");
      }
    }
  }

  for (const stale of state.agentFiles.filter((f) => !produced.includes(f) && existsSync(f))) {
    rmSync(stale);
    reporter.item(stale, "updated", "removed — no longer listed");
  }
  state.agentFiles = produced;
  saveState(paths.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
