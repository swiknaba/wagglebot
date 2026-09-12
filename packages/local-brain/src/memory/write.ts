import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const writeMemoryAtomically = (target: string, content: string): void => {
  const directory = dirname(target);
  const mode = (() => {
    try {
      return statSync(target).mode & 0o777;
    } catch {
      return 0o644;
    }
  })();
  const temporary = join(directory, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.memory.tmp`);
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeSync(file, content, undefined, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    if (file !== undefined) closeSync(file);
    rmSync(temporary, { force: true });
  }
};
