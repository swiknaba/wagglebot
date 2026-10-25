import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ContextBridgeExportInputSchema } from "@wagglebot/contracts";
import { withVaultCoordination } from "./coordination";
import { ContextBridgeError, createBridgePacket } from "./packet";
import { ContextVault } from "./vault";

const identity = { workingTree: "clean" as const, catalogState: "resolved" as const };
const rootKey = `rk_${"a".repeat(32)}`;
const makePacket = (now: Date) =>
  createBridgePacket(
    ContextBridgeExportInputSchema.parse({
      projectPath: "/repo",
      goal: "Continue safely",
      decisions: [],
      openQuestions: [],
      evidence: [],
      providerState: { localBrain: "ready", sharedMemory: "not_requested" },
    }),
    identity,
    rootKey,
    now,
  );
const vaultAt = async (now: () => Date) => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-test-"));
  const directory = join(parent, "context");
  return { directory, vault: new ContextVault({ directory, now }) };
};
const coordinationDatabase = (directory: string) => {
  const suffix = `${basename(directory)}-${createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 16)}`;
  return join(dirname(directory), `.context-coordination-${suffix}`, "context-vault.sqlite");
};

test("vault creates protected files and survives reopen while counting imports", async () => {
  const now = () => new Date("2026-10-25T10:00:00Z");
  const { directory, vault } = await vaultAt(now);
  const result = await vault.export(makePacket(now()));
  expect(result.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(entries).toHaveLength(1);
  const packetFile = entries[0];
  if (!packetFile) throw new Error("expected one packet file");
  expect((await stat(join(directory, packetFile))).mode & 0o777).toBe(0o600);

  const reopened = new ContextVault({ directory, now });
  for (let count = 1; count <= 8; count += 1) {
    const imported = await reopened.import(result.handle, rootKey);
    expect(imported.packet.packetId).toBe(result.packetMeta.packetId);
  }
  await expect(reopened.import(result.handle, rootKey)).rejects.toMatchObject({ code: "context_limit" });
  expect((await reopened.status(rootKey)).packets[0]?.importCount).toBe(8);
});

test("vault accepts a user-owned shared state parent without write access", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-shared-root-"));
  const stateDirectory = join(parent, "hub-state");
  await mkdir(stateDirectory, { mode: 0o755 });
  await chmod(stateDirectory, 0o755);
  const vault = new ContextVault({ stateDirectory, now: () => new Date("2026-10-25T10:00:00Z") });
  const result = await vault.export(makePacket(new Date("2026-10-25T10:00:00Z")));
  expect(result.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await stat(stateDirectory)).mode & 0o777).toBe(0o755);
  await expect(vault.cleanup()).resolves.toBeUndefined();
});

test("vault refuses a user-owned state parent writable by other users", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-unsafe-root-"));
  const stateDirectory = join(parent, "hub-state");
  await mkdir(stateDirectory, { mode: 0o777 });
  await chmod(stateDirectory, 0o777);
  const vault = new ContextVault({ stateDirectory });
  await expect(vault.export(makePacket(new Date()))).rejects.toMatchObject({ code: "context_owner_mismatch" });
});

test("separate vault instances share the eight-import limit", async () => {
  const now = () => new Date("2026-10-25T10:00:00Z");
  const { directory, vault } = await vaultAt(now);
  const other = new ContextVault({ directory, now });
  const result = await vault.export(makePacket(now()));
  const attempts = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) => (index % 2 ? vault : other).import(result.handle, rootKey)),
  );
  expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(8);
  expect(
    attempts.filter((attempt) => attempt.status === "rejected" && attempt.reason.code === "context_limit"),
  ).toHaveLength(8);
});

test("subprocess stress shares the eight-import limit across repeated concurrent runs", async () => {
  const script = `
    try {
      const { ContextVault } = await import(process.env.VAULT_MODULE);
      const vault = new ContextVault({
        directory: process.env.VAULT_DIRECTORY,
        now: () => new Date(process.env.VAULT_NOW),
      });
      let successes = 0;
      for (let index = 0; index < 8; index += 1) {
        try {
          await vault.import(process.env.VAULT_HANDLE, process.env.VAULT_ROOT_KEY);
          successes += 1;
        } catch (error) {
          if (error.code !== "context_limit") throw error;
        }
      }
      console.log(successes);
    } catch (error) {
      console.log("failed:" + error.name + ":" + (error.code ?? "unknown"));
      process.exitCode = 1;
    }
  `;
  for (let trial = 0; trial < 10; trial += 1) {
    const now = () => new Date("2026-10-25T10:00:00Z");
    const { directory, vault } = await vaultAt(now);
    const result = await vault.export(makePacket(now()));
    const run = () =>
      Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          VAULT_MODULE: join(import.meta.dir, "vault.ts"),
          VAULT_DIRECTORY: directory,
          VAULT_HANDLE: result.handle,
          VAULT_ROOT_KEY: rootKey,
          VAULT_NOW: now().toISOString(),
        },
        stdout: "pipe",
        stderr: "ignore",
      });
    const children = [run(), run()];
    const successes = await Promise.all(
      children.map(async (child) => {
        const output = await new Response(child.stdout).text();
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(`vault subprocess failed: ${output.trim()}`);
        return Number(output.trim());
      }),
    );
    expect(successes.reduce((sum, count) => sum + count, 0)).toBe(8);
    expect((await vault.status(rootKey)).packets[0]?.importCount).toBe(8);
  }
});

test("separate vault instances share the export packet limit", async () => {
  const now = () => new Date("2026-10-25T10:00:00Z");
  const { directory, vault } = await vaultAt(now);
  const other = new ContextVault({ directory, now });
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, (_, index) =>
      (index % 2 ? vault : other).export(makePacket(new Date(now().getTime() + index))),
    ),
  );
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(32);
  expect(
    results.filter((result) => result.status === "rejected" && result.reason.code === "context_limit"),
  ).toHaveLength(8);
});

test("separate processes share the 32-packet export limit", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-process-export-"));
  const directory = join(parent, "context");
  const script = `
    const { ContextVault } = await import(process.env.VAULT_MODULE);
    const { createBridgePacket } = await import(process.env.PACKET_MODULE);
    const { ContextBridgeExportInputSchema } = await import(process.env.CONTRACTS_MODULE);
    const vault = new ContextVault({ directory: process.env.VAULT_DIRECTORY });
    const input = ContextBridgeExportInputSchema.parse({
      projectPath: "/repo", goal: "Continue safely", decisions: [], openQuestions: [], evidence: [],
      providerState: { localBrain: "ready", sharedMemory: "not_requested" },
    });
    const project = { workingTree: "clean", catalogState: "resolved" };
    let successes = 0;
    for (let index = 0; index < 20; index += 1) {
      const packet = createBridgePacket(input, project, process.env.VAULT_ROOT_KEY, new Date(Date.now() + index));
      try {
        await vault.export(packet);
        successes += 1;
      } catch (error) {
        if (error.code !== "context_limit") throw error;
      }
    }
    console.log(successes);
  `;
  const run = () =>
    Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        VAULT_MODULE: join(import.meta.dir, "vault.ts"),
        PACKET_MODULE: join(import.meta.dir, "packet.ts"),
        CONTRACTS_MODULE: join(import.meta.dir, "../../../contracts/src/index.ts"),
        VAULT_DIRECTORY: directory,
        VAULT_ROOT_KEY: rootKey,
      },
      stdout: "pipe",
      stderr: "ignore",
    });
  const children = [run(), run()];
  const successes = await Promise.all(
    children.map(async (child) => {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return Number(output.trim());
    }),
  );
  expect(successes.reduce((sum, count) => sum + count, 0)).toBe(32);
});

test("coordination database refuses symlinks and insecure files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-db-"));
  const directory = join(parent, "context");
  const database = coordinationDatabase(directory);
  await mkdir(dirname(database), { mode: 0o700 });
  await writeFile(join(parent, "outside.sqlite"), "not a database");
  await symlink(join(parent, "outside.sqlite"), database);
  const linked = new ContextVault({ directory });
  await expect(linked.status(rootKey)).rejects.toMatchObject({ code: "context_owner_mismatch" });

  await import("node:fs/promises").then(({ unlink }) => unlink(database));
  const secure = new ContextVault({ directory });
  await secure.export(makePacket(new Date("2026-10-25T10:00:00Z")));
  await chmod(database, 0o644);
  await expect(secure.status(rootKey)).rejects.toMatchObject({ code: "context_owner_mismatch" });
});

test("SQLite commit retries a transient reader lock without repeating the operation", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "wagglebot-context-commit-lock-"));
  const packetDirectory = join(stateDirectory, "context");
  const databasePath = coordinationDatabase(packetDirectory);
  await withVaultCoordination(stateDirectory, packetDirectory, async () => undefined);
  const reader = new Database(databasePath, { create: false, readwrite: true });
  reader.exec("BEGIN");
  reader.query("SELECT * FROM context_imports").all();

  let operationCalls = 0;
  let settled = false;
  const pending = withVaultCoordination(stateDirectory, packetDirectory, async (database) => {
    operationCalls += 1;
    database.query("INSERT INTO context_imports (packet_file, import_count) VALUES (?, ?)").run("once", 1);
  }).then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );

  try {
    const deadline = Date.now() + 1_000;
    while (operationCalls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(operationCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
  } finally {
    reader.exec("COMMIT");
    reader.close();
  }

  await pending;
  expect(operationCalls).toBe(1);
  const verification = new Database(databasePath, { create: false, readwrite: true });
  expect(verification.query("SELECT import_count FROM context_imports WHERE packet_file = ?").get("once")).toEqual({
    import_count: 1,
  });
  verification.close();
});

test("SQLite coordination lock recovers after its owning process is killed", async () => {
  const now = () => new Date("2026-10-25T10:00:00Z");
  const { directory, vault } = await vaultAt(now);
  const result = await vault.export(makePacket(now()));
  const parent = directory.slice(0, directory.lastIndexOf("/"));
  const marker = join(parent, "locked");
  const database = coordinationDatabase(directory);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { Database } from "bun:sqlite"; import { writeFileSync } from "node:fs"; const db = new Database(process.env.VAULT_DB); db.exec("BEGIN IMMEDIATE"); db.query("UPDATE context_imports SET import_count = 8").run(); writeFileSync(process.env.VAULT_MARKER, "ready"); await new Promise(() => {});',
    ],
    { env: { ...process.env, VAULT_DB: database, VAULT_MARKER: marker }, stdout: "ignore", stderr: "ignore" },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await readdir(parent)).every((name) => name !== "locked"))
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await readdir(parent)).includes("locked")).toBe(true);
  let settled = false;
  const pending = vault.import(result.handle, rootKey).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    expect(settled).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const outcome = await pending;
  if ("error" in outcome) throw outcome.error;
  expect(outcome.value.packet.packetId).toBe(result.packetMeta.packetId);
  expect((await vault.status(rootKey)).packets[0]?.importCount).toBe(1);
});

test("project scope blocks another root, workstation scope permits it, and revoke is idempotent", async () => {
  const now = () => new Date("2026-10-25T10:00:00Z");
  const { vault } = await vaultAt(now);
  const project = await vault.export(makePacket(now()));
  await expect(vault.import(project.handle, `rk_${"b".repeat(32)}`)).rejects.toMatchObject({
    code: "context_project_mismatch",
  });
  const workstationPacket = { ...makePacket(now()), scope: "workstation" as const };
  const workstation = await vault.export(workstationPacket);
  expect((await vault.import(workstation.handle, `rk_${"b".repeat(32)}`)).packet.scope).toBe("workstation");
  expect(await vault.revoke(project.handle)).toEqual({ schemaVersion: 1, revoked: true });
  expect(await vault.revoke(project.handle)).toEqual({ schemaVersion: 1, revoked: true });
});

test("expiry is pruned and a mode violation fails closed", async () => {
  let current = new Date("2026-10-25T10:00:00Z");
  const { directory, vault } = await vaultAt(() => current);
  const result = await vault.export(makePacket(current));
  current = new Date("2026-10-25T12:00:00Z");
  expect(await vault.status(rootKey)).toMatchObject({ packetCount: 0, packets: [] });
  expect(await vault.revoke(result.handle)).toEqual({ schemaVersion: 1, revoked: true });
  await chmod(directory, 0o755);
  await expect(vault.status(rootKey)).rejects.toBeInstanceOf(ContextBridgeError);
});
