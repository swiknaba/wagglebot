import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestBackupSet, restoreSet, startBackupSet } from "./backup";

test("backs up before mutation, restores the newest set", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  const target = join(root, "CLAUDE.md");
  writeFileSync(target, "original");
  const set = startBackupSet(join(root, "backups"), new Date("2026-08-31T10:00:00Z"));
  set.backup(target);
  set.backup(target); // second call is a no-op
  writeFileSync(target, "mutated");
  const newest = newestBackupSet(join(root, "backups"));
  expect(newest).toBe(set.dir);
  const restored = restoreSet(set.dir);
  expect(restored).toEqual([target]);
  expect(readFileSync(target, "utf8")).toBe("original");
});

test("backup of a missing target is a no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  const set = startBackupSet(join(root, "backups"));
  set.backup(join(root, "absent.md"));
  expect(restoreSet(set.dir)).toEqual([]);
});
