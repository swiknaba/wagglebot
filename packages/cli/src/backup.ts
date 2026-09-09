import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Millisecond precision: two commands inside one second must not share one set, because the
// second would overwrite the backup of the first with an already-mutated file.
// "20260831-100000100" — fixed width, so a name sort is a time sort.
const stamp = (d: Date): string => d.toISOString().replaceAll(/[-:.]/g, "").replace("T", "-").slice(0, 18);
const encode = (p: string): string => p.replaceAll("/", "%2F");
const decode = (name: string): string => name.replaceAll("%2F", "/");

export type BackupSet = { dir: string; backup(targetFile: string): void };

export function startBackupSet(backupsDir: string, now = new Date()): BackupSet {
  const dir = join(backupsDir, stamp(now));
  const done = new Set<string>();
  return {
    dir,
    backup(targetFile) {
      if (done.has(targetFile) || !existsSync(targetFile)) return;
      mkdirSync(dir, { recursive: true });
      copyFileSync(targetFile, join(dir, encode(targetFile)));
      done.add(targetFile);
    },
  };
}

export function newestBackupSet(backupsDir: string): string | undefined {
  if (!existsSync(backupsDir)) return undefined;
  const sets = [...readdirSync(backupsDir)].sort();
  const last = sets.at(-1);
  return last === undefined ? undefined : join(backupsDir, last);
}

export type RestoreResult = { restored: string[]; failed: { target: string; error: string }[] };

export function restoreSet(setDir: string, onlyTarget?: string): RestoreResult {
  const result: RestoreResult = { restored: [], failed: [] };
  if (!existsSync(setDir)) return result;
  for (const target of readdirSync(setDir).map(decode)) {
    if (onlyTarget !== undefined && target !== onlyTarget) continue;
    try {
      copyFileSync(join(setDir, encode(target)), target);
      result.restored.push(target);
    } catch (error) {
      result.failed.push({ target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
