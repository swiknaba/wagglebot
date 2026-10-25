import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceKey } from "../../../packages/knowledge/src/keys";
import { createGitRevisionVerifier, createPublicationService, scopeIdentity } from "../src/publication";
import { createMemoryRepository, type MemoryRepository, type MemoryTransaction } from "../src/repository";

const repository = process.env.MEMORY_DATABASE_URL ? createMemoryRepository() : undefined;
const integrationTest = repository ? test : test.skip;
afterAll(async () => repository?.close());

integrationTest("pgvector publication replaces complete revisions atomically and replays after restart", async () => {
  const db = repository;
  if (!db) throw new Error("MEMORY_DATABASE_URL is required for publication SQL tests");
  await db.assertReady();
  const originalState = (await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state;
  const directory = mkdtempSync(join(tmpdir(), "wagglebot-publication-sql-"));
  const identity = `publication-test-${randomUUID()}`;
  const path = "knowledge.md";
  const scope = { kind: "system" as const, name: "publication-test" };
  const key = sourceKey(identity, path, scopeIdentity(scope));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (body: string) => {
    writeFileSync(join(directory, path), body);
    git("add", path);
    git("commit", "--quiet", "-m", "reviewed revision");
    return git("rev-parse", "HEAD");
  };
  const service = (database = db) =>
    createPublicationService({
      repository: database,
      git: createGitRevisionVerifier({ [identity]: directory }),
      loadCatalog: async () => ({
        users: [],
        groups: [{ name: "team", members: [] }],
        systems: [{ name: scope.name, owner: "team", domain: "publication-domain" }],
        domains: [{ name: "publication-domain", owner: "team" }],
      }),
      scanner: { scanPersistedDTO: async () => ({ count: 0 }) },
      embeddingProvider: { embed: async () => Array(384).fill(0.1) },
      clock: () => new Date("2026-10-24T10:00:00Z"),
    });
  const chunk = (chunkKey: string, content: string) => ({
    chunkKey,
    heading: chunkKey,
    title: chunkKey,
    content,
    kind: "fact",
    confidence: "high",
    wake: false,
    provenance: [{ sourceType: "git", actor: "team", capturedAt: "2026-10-24T10:00:00Z" }],
  });
  const request = (revision: string, operation: string, chunks: ReturnType<typeof chunk>[]) => ({
    schemaVersion: 1,
    operationKey: `${identity}-${operation}`,
    revision,
    repository: identity,
    path,
    scope,
    owner: "team",
    chunks,
  });
  const records = () =>
    db.query("SELECT * FROM wagglebot_memories WHERE scopes = $1::text[] ORDER BY id", [[`system:${scope.name}`]]);
  try {
    git("init", "--quiet");
    git("config", "user.name", "Publication Test");
    git("config", "user.email", "publication@example.invalid");
    const firstRevision = commit("First chunk\nSecond chunk\n");
    const firstRequest = request(firstRevision, "first", [
      chunk("one", "First chunk\n"),
      chunk("two", "Second chunk\n"),
    ]);
    const first = await service().replaceSource(key, firstRequest);
    expect(first).toMatchObject({ created: 2, invalidated: 0 });
    expect(await service().replaceSource(key, firstRequest)).toEqual(first);
    expect(
      await service().replaceSource(key, { ...firstRequest, operationKey: `${identity}-same-revision` }),
    ).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    const before = await records();
    expect(before.every((row) => row.active === true)).toBe(true);
    expect(
      before.every((row) =>
        (row.provenance as Array<{ actor: string; commitSha: string }>).some(
          (entry) => entry.actor === "team" && entry.commitSha === firstRevision,
        ),
      ),
    ).toBe(true);

    const nextRevision = commit("Changed first\nChanged second\n");
    let inserted = 0;
    const failing: MemoryRepository = {
      ...db,
      withTransaction: (callback) =>
        db.withTransaction((tx) =>
          callback({
            query: async (sql: string, values?: unknown[]) => {
              if (sql.trimStart().startsWith("INSERT INTO wagglebot_memories") && ++inserted === 2)
                await tx.query("SELECT 1 / 0");
              return tx.query(sql, values);
            },
          } as MemoryTransaction),
        ),
    };
    const nextRequest = request(nextRevision, "next", [
      chunk("one", "Changed first\n"),
      chunk("two", "Changed second\n"),
    ]);
    const stateBeforeFailure = (await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]
      ?.worker_state;
    await expect(service(failing).replaceSource(key, nextRequest)).rejects.toThrow();
    expect(inserted).toBe(2);
    expect(await records()).toEqual(before);
    expect((await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state).toEqual(
      stateBeforeFailure,
    );

    expect(await service().replaceSource(key, nextRequest)).toMatchObject({ created: 0, updated: 2 });
    expect((await records()).filter((row) => row.active === true)).toHaveLength(2);
    await expect(
      service().replaceSource(key, { ...firstRequest, operationKey: `${identity}-regressed` }),
    ).rejects.toMatchObject({ code: "source_revision_regressed" });
    const removedRevision = commit("");
    const removal = request(removedRevision, "remove", []);
    const removed = await service().replaceSource(key, removal);
    expect(removed).toMatchObject({ created: 0, invalidated: 2 });
    expect((await records()).some((row) => row.active === true)).toBe(false);
    expect(await service().replaceSource(key, removal)).toEqual(removed);
  } finally {
    await db.query("DELETE FROM wagglebot_memories WHERE scopes = $1::text[]", [[`system:${scope.name}`]]);
    if (originalState !== undefined)
      await db.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [
        JSON.stringify(originalState),
      ]);
    rmSync(directory, { recursive: true, force: true });
  }
});
