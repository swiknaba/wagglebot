import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupSet } from "../backup";
import { newestBackupSet, restoreSet, startBackupSet } from "../backup";
import { HARNESSES, templatesDir } from "../harness";
import { renderManagedBlock } from "../managed-block";
import { mergeHooks } from "../managed-json";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { renderTemplate } from "../template";

export type SyncOptions = { dryRun?: boolean; restore?: boolean; restoreTarget?: string };

const readIfExists = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export function runSyncAgents(deps: {
  home: string;
  instructionsDir?: string;
  reporter: Reporter;
  options?: SyncOptions;
  backups?: BackupSet;
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
    for (const target of restoreSet(set, options.restoreTarget)) reporter.item(target, "updated", "restored");
    return 0;
  }

  const base = readFileSync(join(templatesDir(), "AGENTS.base.md"), "utf8");
  const instructionsDir = deps.instructionsDir;
  const instructions =
    instructionsDir !== undefined && existsSync(instructionsDir)
      ? [...readdirSync(instructionsDir)]
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => readFileSync(join(instructionsDir, f), "utf8"))
      : [];
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
      if (options.dryRun === true) {
        reporter.item(relative, "skipped", "would sync (dry run)");
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

  for (const harness of HARNESSES) {
    for (const relative of harness.templateTargets) {
      writeTarget(relative, (existing) => renderManagedBlock(existing, rendered), 0o600);
    }
    const hooksTarget = harness.hooksTarget;
    if (hooksTarget !== undefined) {
      const fragmentText = readFileSync(join(templatesDir(), "hooks", hooksTarget.fragmentFile), "utf8");
      const fragment: { hooks: Record<string, unknown[]> } = JSON.parse(fragmentText);
      writeTarget(hooksTarget.path, (existing) => mergeHooks(existing, fragment));
    }
  }
  return reporter.failed() ? 1 : 0;
}
