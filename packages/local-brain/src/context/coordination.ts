import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ContextBridgeError } from "./packet";

const COORDINATION_DATABASE = "context-vault.sqlite";
const COORDINATION_DIRECTORY = ".context-coordination";
const LOCK_TIMEOUT_MS = 5_000;
const ownerId = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);
const codeIs = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const assertSafeDatabaseFile = async (
  path: string,
  descriptor: Awaited<ReturnType<typeof open>>,
): Promise<{ dev: number; ino: number }> => {
  const [info, linked] = await Promise.all([descriptor.stat(), lstat(path)]);
  const uid = ownerId();
  if (
    linked.isSymbolicLink() ||
    !info.isFile() ||
    !linked.isFile() ||
    info.nlink !== 1 ||
    linked.nlink !== 1 ||
    (uid !== undefined && info.uid !== uid) ||
    (uid !== undefined && linked.uid !== uid) ||
    (info.mode & 0o777) !== 0o600 ||
    (linked.mode & 0o777) !== 0o600 ||
    info.dev !== linked.dev ||
    info.ino !== linked.ino
  ) {
    throw new ContextBridgeError("context_owner_mismatch");
  }
  return { dev: info.dev, ino: info.ino };
};

const ensureDatabaseFile = async (path: string): Promise<{ dev: number; ino: number }> => {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_RDWR | noFollow;
  let file: Awaited<ReturnType<typeof open>>;
  let created = false;
  try {
    file = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
  } catch (error) {
    if (codeIs(error, "ELOOP")) throw new ContextBridgeError("context_owner_mismatch");
    if (!codeIs(error, "EEXIST")) throw new ContextBridgeError("context_unavailable");
    try {
      file = await open(path, flags);
    } catch (openError) {
      if (codeIs(openError, "ELOOP")) throw new ContextBridgeError("context_owner_mismatch");
      throw new ContextBridgeError("context_unavailable");
    }
  }
  try {
    if (created) await file.chmod(0o600);
    return await assertSafeDatabaseFile(path, file);
  } finally {
    await file.close();
  }
};

const retryBusy = async (operation: () => void): Promise<void> => {
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  while (true) {
    try {
      operation();
      return;
    } catch (error) {
      if (!codeIs(error, "SQLITE_BUSY")) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ContextBridgeError("context_unavailable");
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 50);
    }
  }
};

export async function withVaultCoordination<T>(
  stateDirectory: string,
  packetDirectory: string,
  operation: (database: Database) => Promise<T>,
): Promise<T> {
  const directoryName = `${basename(packetDirectory)}-${createHash("sha256").update(resolve(packetDirectory)).digest("hex").slice(0, 16)}`;
  const coordinationDirectory = join(stateDirectory, `${COORDINATION_DIRECTORY}-${directoryName}`);
  let created = false;
  try {
    await mkdir(coordinationDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!codeIs(error, "EEXIST")) throw new ContextBridgeError("context_unavailable");
  }
  if (created) await chmod(coordinationDirectory, 0o700);
  const directoryInfo = await lstat(coordinationDirectory);
  if (
    directoryInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() ||
    (ownerId() !== undefined && directoryInfo.uid !== ownerId()) ||
    (directoryInfo.mode & 0o777) !== 0o700
  ) {
    throw new ContextBridgeError("context_owner_mismatch");
  }
  const path = join(coordinationDirectory, COORDINATION_DATABASE);
  const identity = await ensureDatabaseFile(path);
  let database: Database | undefined;
  let transaction = false;
  try {
    database = new Database(path, { create: false, readwrite: true });
    database.exec("PRAGMA busy_timeout=0");
    const linked = await lstat(path);
    const uid = ownerId();
    if (
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      (linked.mode & 0o777) !== 0o600 ||
      (uid !== undefined && linked.uid !== uid) ||
      linked.dev !== identity.dev ||
      linked.ino !== identity.ino
    ) {
      throw new ContextBridgeError("context_owner_mismatch");
    }
    await retryBusy(() => database?.exec("BEGIN IMMEDIATE"));
    transaction = true;
    database.exec(
      "CREATE TABLE IF NOT EXISTS context_imports (packet_file TEXT PRIMARY KEY, import_count INTEGER NOT NULL CHECK (import_count >= 0 AND import_count <= 8))",
    );
    const result = await operation(database);
    await retryBusy(() => database?.exec("COMMIT"));
    transaction = false;
    return result;
  } catch (error) {
    if (transaction && database) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Closing the connection also releases SQLite's process lock.
      }
    }
    if (error instanceof ContextBridgeError) throw error;
    throw new ContextBridgeError("context_unavailable");
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        // Closing is still attempted after commit or rollback to release the process lock.
      }
    }
  }
}
