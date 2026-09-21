import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BackupSet } from "../backup";
import { newestBackupSet, restoreSet, startBackupSet } from "../backup";
import type { Harness } from "../harness";
import { templatesDir } from "../harness";
import { renderManagedBlock } from "../managed-block";
import { type HookFragment, mergeHooks, replaceJsonCategory } from "../managed-json";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { renderTemplate } from "../template";

const readIfExists = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export function restoreHarnesses(input: { home: string; reporter: Reporter; target?: string }): number {
  const { reporter } = input;
  const set = newestBackupSet(resolvePaths(input.home).backupsDir);
  if (set === undefined) {
    reporter.item("restore", "failed", "no backup set exists");
    return 1;
  }
  const result = restoreSet(set, input.target);
  for (const target of result.restored) reporter.item(target, "updated", "restored");
  for (const failure of result.failed) reporter.item(failure.target, "failed", failure.error);
  return result.failed.length > 0 ? 1 : 0;
}

export function runSyncHarnesses(deps: {
  home: string;
  harnesses: Harness[];
  instructionDirs: string[];
  reporter: Reporter;
  overwriteLocal?: boolean;
  backups?: BackupSet;
  fragmentsDir?: string;
}): number {
  const { home, reporter } = deps;
  const paths = resolvePaths(home);
  reporter.section("Base template sync");

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
  const backups = deps.overwriteLocal ? undefined : (deps.backups ?? startBackupSet(paths.backupsDir));

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
      backups?.backup(target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, result.next);
      if (mode !== undefined) chmodSync(target, mode);
      reporter.item(relative, "updated", "synced");
    } catch (error) {
      reporter.item(relative, "failed", error instanceof Error ? error.message : String(error));
    }
  };

  const fragmentsDir = deps.fragmentsDir ?? join(templatesDir(), "hooks");
  const readFragment = (file: string): HookFragment => JSON.parse(readFileSync(join(fragmentsDir, file), "utf8"));

  for (const harness of deps.harnesses) {
    for (const relative of harness.templateTargets) {
      writeTarget(
        relative,
        (existing) =>
          deps.overwriteLocal
            ? { next: rendered, changed: existing !== rendered }
            : renderManagedBlock(existing, rendered),
        0o600,
      );
    }
    if (harness.hookTargets.length === 0) {
      reporter.item(`${harness.name} hooks`, "skipped", "unsupported. Durable rules are in the global instructions");
    }
    for (const hooksTarget of harness.hookTargets) {
      writeTarget(
        hooksTarget.path,
        (existing) => {
          // Read and validate inside the target boundary so other targets continue after a failure.
          const fragment = readFragment(hooksTarget.fragmentFile);
          if (!deps.overwriteLocal) return mergeHooks(existing, fragment);
          const replacement = mergeHooks("", fragment).next;
          // Only dedicated Wagglebot files permit replacement of the complete document.
          if (hooksTarget.format === "owned-json-file" && basename(hooksTarget.path) === "wagglebot.json") {
            return { next: replacement, changed: replacement !== existing };
          }
          const result = replaceJsonCategory(existing, "hooks", fragment.hooks);
          if (fragment.version === undefined) return result;
          const versioned = replaceJsonCategory(result.next, "version", fragment.version);
          return { next: versioned.next, changed: result.changed || versioned.changed };
        },
        0o600,
      );
    }
  }
  return reporter.failed() ? 1 : 0;
}
