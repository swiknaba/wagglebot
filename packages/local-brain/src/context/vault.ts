import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ContextBridgePacket, ContextBridgeStatusResult } from "@wagglebot/contracts";
import { ContextBridgePacketSchema } from "@wagglebot/contracts";
import { withVaultCoordination } from "./coordination";
import { assertSafeBridgePacket, ContextBridgeError } from "./packet";

const MAX_PACKETS = 32;
const MAX_BYTES = 512 * 1024;
const MAX_IMPORTS = 8;
type VaultEntry = { schemaVersion: 1; packet: ContextBridgePacket; importCount: number };
const parseVaultEntry = (value: unknown): VaultEntry | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "importCount,packet,schemaVersion" ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.importCount) ||
    (record.importCount as number) < 0 ||
    (record.importCount as number) > MAX_IMPORTS
  )
    return undefined;
  const packet = ContextBridgePacketSchema.safeParse(record.packet);
  return packet.success
    ? { schemaVersion: 1, packet: packet.data, importCount: record.importCount as number }
    : undefined;
};
type EntryFile = { name: string; path: string; size: number; entry: VaultEntry };

const ownerId = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

export class ContextVault {
  readonly #directory: string;
  readonly #stateDirectory: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; stateDirectory?: string; now?: () => Date } = {}) {
    this.#stateDirectory =
      options.stateDirectory ?? (options.directory ? dirname(options.directory) : join(homedir(), ".wagglebot"));
    this.#directory = options.directory ?? join(this.#stateDirectory as string, "context");
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async cleanup(): Promise<void> {
    try {
      return await this.#exclusive(false, async (database) => {
        try {
          await this.#ensureDirectory(false);
        } catch (error) {
          if (error instanceof ContextBridgeError && error.code === "context_unavailable") return;
          throw error;
        }
        await this.#entries(true, database);
      });
    } catch (error) {
      if (error instanceof ContextBridgeError && error.code === "context_unavailable") return;
      throw error;
    }
  }

  async export(
    packet: ContextBridgePacket,
  ): Promise<{ handle: string; packetMeta: Omit<ContextBridgeStatusResult["packets"][number], "importCount"> }> {
    return this.#exclusive(true, async (database) => {
      await this.#ensureDirectory(true);
      const files = await this.#entries(true, database);
      const serialized = JSON.stringify({ schemaVersion: 1, packet, importCount: 0 });
      if (
        files.length >= MAX_PACKETS ||
        files.reduce((sum, file) => sum + file.size, 0) + Buffer.byteLength(serialized) > MAX_BYTES
      ) {
        throw new ContextBridgeError("context_limit");
      }
      const handle = randomBytes(32).toString("base64url");
      const filename = `${createHash("sha256").update(handle).digest("hex")}.json`;
      await this.#atomicWrite(join(this.#directory, filename), serialized);
      database.query("INSERT INTO context_imports (packet_file, import_count) VALUES (?, 0)").run(filename);
      return { handle, packetMeta: this.#packetMeta(packet) };
    });
  }

  async import(
    handle: string,
    rootKey: string,
  ): Promise<{
    packet: ContextBridgePacket;
    packetMeta: Omit<ContextBridgeStatusResult["packets"][number], "importCount">;
  }> {
    return this.#exclusive(false, async (database) => {
      await this.#ensureDirectory(false);
      const path = this.#pathForHandle(handle);
      const entry = await this.#readEntry(path, true, true);
      if (!entry) throw new ContextBridgeError("context_expired");
      if (Date.parse(entry.packet.expiresAt) <= this.now().getTime()) {
        await this.#remove(path);
        this.#deleteImportCount(database, basename(path));
        throw new ContextBridgeError("context_expired");
      }
      if (entry.packet.scope === "project" && entry.packet.project.rootKey !== rootKey) {
        throw new ContextBridgeError("context_project_mismatch");
      }
      const filename = basename(path);
      const importCount = this.#importCount(database, filename, entry.importCount);
      if (importCount >= MAX_IMPORTS) throw new ContextBridgeError("context_limit");
      database
        .query("UPDATE context_imports SET import_count = ? WHERE packet_file = ?")
        .run(importCount + 1, filename);
      return { packet: entry.packet, packetMeta: this.#packetMeta(entry.packet) };
    });
  }

  async status(rootKey: string): Promise<ContextBridgeStatusResult> {
    try {
      return await this.#exclusive(false, async (database) => {
        try {
          await this.#ensureDirectory(false);
        } catch (error) {
          if (error instanceof ContextBridgeError && error.code === "context_unavailable")
            return { schemaVersion: 1, packetCount: 0, packets: [] };
          throw error;
        }
        const files = await this.#entries(true, database);
        const packets = files
          .filter(({ entry }) => entry.packet.scope === "workstation" || entry.packet.project.rootKey === rootKey)
          .map(({ name, entry }) => ({
            ...this.#packetMeta(entry.packet),
            importCount: this.#importCount(database, name, entry.importCount),
          }));
        return { schemaVersion: 1, packetCount: packets.length, packets };
      });
    } catch (error) {
      if (error instanceof ContextBridgeError && error.code === "context_unavailable")
        return { schemaVersion: 1, packetCount: 0, packets: [] };
      throw error;
    }
  }

  async revoke(handle: string): Promise<{ schemaVersion: 1; revoked: true }> {
    try {
      return await this.#exclusive(false, async (database) => {
        try {
          await this.#ensureDirectory(false);
        } catch (error) {
          if (error instanceof ContextBridgeError && error.code === "context_unavailable")
            return { schemaVersion: 1, revoked: true };
          throw error;
        }
        const path = this.#pathForHandle(handle);
        const filename = basename(path);
        const entry = await this.#readEntry(path, true);
        if (!entry) {
          this.#deleteImportCount(database, filename);
          return { schemaVersion: 1, revoked: true };
        }
        await this.#remove(path);
        this.#deleteImportCount(database, filename);
        return { schemaVersion: 1, revoked: true };
      });
    } catch (error) {
      if (error instanceof ContextBridgeError && error.code === "context_unavailable")
        return { schemaVersion: 1, revoked: true };
      throw error;
    }
  }

  async #ensureDirectory(create: boolean): Promise<void> {
    try {
      await this.#secureDirectory(this.#directory, create);
    } catch (error) {
      if (isMissing(error) && !create) throw new ContextBridgeError("context_unavailable");
      throw error;
    }
  }

  async #secureDirectory(path: string, create: boolean, strict = true): Promise<void> {
    let created = false;
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (!isMissing(error) && !(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (isMissing(error)) {
          await mkdir(path, { mode: 0o700 });
          created = true;
        }
      }
    }
    if (created) await chmod(path, 0o700);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (ownerId() !== undefined && info.uid !== ownerId()) ||
      (strict ? (info.mode & 0o777) !== 0o700 : (info.mode & 0o022) !== 0)
    ) {
      throw new ContextBridgeError("context_owner_mismatch");
    }
  }

  async #entries(removeExpired: boolean, database: Database): Promise<EntryFile[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const entries: EntryFile[] = [];
    for (const name of names) {
      if (/^\.tmp-[a-f0-9]{24}$/u.test(name)) {
        if (removeExpired) await this.#remove(join(this.#directory, name));
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const path = join(this.#directory, name);
      const entry = await this.#readEntry(path, removeExpired);
      if (!entry) continue;
      let stat: Stats;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (Date.parse(entry.packet.expiresAt) <= this.now().getTime()) {
        if (removeExpired) await this.#remove(path);
        continue;
      }
      this.#importCount(database, name, entry.importCount);
      entries.push({ name, path, size: stat.size, entry });
    }
    if (entries.length > MAX_PACKETS || entries.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) {
      throw new ContextBridgeError("context_limit");
    }
    const liveNames = new Set(entries.map(({ name }) => name));
    const storedNames = database.query("SELECT packet_file FROM context_imports").all() as Array<{
      packet_file: string;
    }>;
    for (const { packet_file } of storedNames) {
      if (!liveNames.has(packet_file)) this.#deleteImportCount(database, packet_file);
    }
    return entries;
  }

  #importCount(database: Database, filename: string, legacyCount: number): number {
    const row = database.query("SELECT import_count FROM context_imports WHERE packet_file = ?").get(filename) as {
      import_count: number;
    } | null;
    if (row) return row.import_count;
    database.query("INSERT INTO context_imports (packet_file, import_count) VALUES (?, ?)").run(filename, legacyCount);
    return legacyCount;
  }

  #deleteImportCount(database: Database, filename: string): void {
    database.query("DELETE FROM context_imports WHERE packet_file = ?").run(filename);
  }

  async #readEntry(path: string, removeCorrupt: boolean, throwCorrupt = false): Promise<VaultEntry | undefined> {
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (ownerId() !== undefined && stat.uid !== ownerId())
    ) {
      throw new ContextBridgeError("context_owner_mismatch");
    }
    if (stat.size > MAX_BYTES) {
      if (removeCorrupt) await this.#remove(path);
      return undefined;
    }
    try {
      const parsed = parseVaultEntry(JSON.parse(await Bun.file(path).text()));
      if (!parsed) throw new Error("corrupt");
      assertSafeBridgePacket(parsed.packet);
      return parsed;
    } catch {
      if (removeCorrupt) await this.#remove(path);
      if (throwCorrupt) throw new ContextBridgeError("context_unavailable");
      return undefined;
    }
  }

  #pathForHandle(handle: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(handle)) throw new ContextBridgeError("context_invalid");
    const filename = `${createHash("sha256").update(handle).digest("hex")}.json`;
    return join(this.#directory, filename);
  }

  #packetMeta(packet: ContextBridgePacket): Omit<ContextBridgeStatusResult["packets"][number], "importCount"> {
    return {
      packetId: packet.packetId,
      scope: packet.scope,
      project: {
        ...(packet.project.component ? { component: packet.project.component } : {}),
        ...(packet.project.system ? { system: packet.project.system } : {}),
        ...(packet.project.branch ? { branch: packet.project.branch } : {}),
        ...(packet.project.head ? { head: packet.project.head } : {}),
      },
      createdAt: packet.createdAt,
      expiresAt: packet.expiresAt,
    };
  }

  async #atomicWrite(path: string, content: string): Promise<void> {
    const temporary = join(this.#directory, `.tmp-${randomBytes(12).toString("hex")}`);
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await file.writeFile(content, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch {
      if (file) await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw new ContextBridgeError("context_unavailable");
    }
  }

  async #remove(path: string): Promise<void> {
    await unlink(path).catch((error) => {
      if (!isMissing(error)) throw new ContextBridgeError("context_unavailable");
    });
  }

  async #exclusive<T>(createState: boolean, operation: (database: Database) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      try {
        await this.#secureDirectory(this.#stateDirectory, createState, false);
      } catch (error) {
        if (isMissing(error)) throw new ContextBridgeError("context_unavailable");
        throw error;
      }
      return await withVaultCoordination(this.#stateDirectory, this.#directory, async (database) => {
        await this.#ensureDirectory(createState);
        return operation(database);
      });
    } finally {
      release();
    }
  }
}
