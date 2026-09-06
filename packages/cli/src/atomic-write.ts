import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Writes the complete content to a sibling temporary file, then renames it over the target.
// A reader sees the old file or the new file, never a half-written one.
export function writeFileAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(
    dirname(target),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wagglebot-tmp`,
  );
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
