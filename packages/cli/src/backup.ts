import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const stamp = (d: Date): string => d.toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
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
  const sets = readdirSync(backupsDir).toSorted();
  const last = sets.at(-1);
  return last === undefined ? undefined : join(backupsDir, last);
}

export function restoreSet(setDir: string, onlyTarget?: string): string[] {
  if (!existsSync(setDir)) return [];
  return readdirSync(setDir)
    .map(decode)
    .filter((target) => onlyTarget === undefined || target === onlyTarget)
    .map((target) => {
      copyFileSync(join(setDir, encode(target)), target);
      return target;
    });
}
