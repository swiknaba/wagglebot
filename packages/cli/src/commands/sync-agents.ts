import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupSet } from "../backup";
import { newestBackupSet, restoreSet, startBackupSet } from "../backup";
import type { Harness } from "../harness";
import { templatesDir } from "../harness";
import { renderManagedBlock } from "../managed-block";
import { mergeHooks } from "../managed-json";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { renderTemplate } from "../template";

export type SyncOptions = { restore?: boolean; restoreTarget?: string };

const readIfExists = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export function runSyncAgents(deps: {
  home: string;
  harnesses: Harness[];
  instructionDirs: string[];
  reporter: Reporter;
  options?: SyncOptions;
  backups?: BackupSet;
  fragmentsDir?: string;
}): number {
  const { home, reporter } = deps;
  const options = deps.options ?? {};
  const paths = resolvePaths(home);
  reporter.section("Base template sync");

  if (options.restore === true) {
    const set = newestBackupSet(paths.backupsDir);
    if (set === undefined) {
      reporter.item("restore", "failed", "no backup set exists");
      return 1;
    }
    const result = restoreSet(set, options.restoreTarget);
    for (const target of result.restored) reporter.item(target, "updated", "restored");
    for (const f of result.failed) reporter.item(f.target, "failed", f.error);
    return result.failed.length > 0 ? 1 : 0;
  }

  const base = readFileSync(join(templatesDir(), "AGENTS.base.md"), "utf8");
  const instructions = deps.instructionDirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      [...readdirSync(dir)]
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => readFileSync(join(dir, f), "utf8")),
    );
  const rendered = renderTemplate(base, instructions);
  const backups = deps.backups ?? startBackupSet(paths.backupsDir);

  const writeTarget = (
    relative: string,
    compute: (existing: string) => { next: string; changed: boolean },
    mode?: number,
  ): void => {
    try {
      const target = join(home, relative);
      const result = compute(readIfExists(target));
      if (!result.changed) {
        reporter.item(relative, "ok", "already ok");
        return;
      }
      backups.backup(target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, result.next);
      if (mode !== undefined) chmodSync(target, mode);
      reporter.item(relative, "updated", "synced");
    } catch (error) {
      reporter.item(relative, "failed", error instanceof Error ? error.message : String(error));
    }
  };

  const fragmentsDir = deps.fragmentsDir ?? join(templatesDir(), "hooks");
  const readFragment = (file: string): { hooks: Record<string, unknown[]> } =>
    JSON.parse(readFileSync(join(fragmentsDir, file), "utf8"));

  for (const harness of deps.harnesses) {
    for (const relative of harness.templateTargets) {
      writeTarget(relative, (existing) => renderManagedBlock(existing, rendered), 0o600);
    }
    const hooksTarget = harness.hooksTarget;
    if (hooksTarget !== undefined) {
      // The fragment is read inside the try of writeTarget: a bad fragment fails this item only.
      writeTarget(hooksTarget.path, (existing) => mergeHooks(existing, readFragment(hooksTarget.fragmentFile)), 0o600);
    }
  }
  return reporter.failed() ? 1 : 0;
}
