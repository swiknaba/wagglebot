import { expect, test } from "bun:test";
import type { Catalog } from "../../../packages/company-config/src/catalog";
import type { PublicationResponse } from "../../../packages/contracts/src/memory";
import { sourceKey } from "../../../packages/knowledge/src/keys";
import { enqueueReindex, startRun } from "./admin-state";
import {
  createGitRevisionVerifier,
  createPublicationService,
  PublicationServiceError,
  preparePublication,
  scopeIdentity,
  validatePublicationOwner,
} from "./publication";
import type { MemoryRepository } from "./repository";

const catalog: Catalog = {
  domains: [{ name: "payments", owner: "team-payments" }],
  systems: [{ name: "billing", domain: "payments", owner: "team-payments" }],
  groups: [{ name: "team-payments", members: ["alice"] }],
  users: [{ name: "alice", memberOf: ["team-payments"], orgOwner: true }],
};

test("publication owners must match catalog scope owners", () => {
  expect(() => validatePublicationOwner({ kind: "domain", name: "payments" }, "team-payments", catalog)).not.toThrow();
  expect(() => validatePublicationOwner({ kind: "system", name: "billing" }, "team-other", catalog)).toThrow();
  expect(() => validatePublicationOwner({ kind: "org" }, "alice", catalog)).not.toThrow();
  expect(() => validatePublicationOwner({ kind: "org" }, "team-payments", catalog)).toThrow();
});

test("publication owner and scope failures use the documented publication error", () => {
  expect(() => validatePublicationOwner({ kind: "domain", name: "missing" }, "team-payments", catalog)).toThrow(
    expect.objectContaining({ code: "publication_invalid", status: 400 }),
  );
  expect(() => validatePublicationOwner({ kind: "domain", name: "payments" }, "alice", catalog)).toThrow(
    expect.objectContaining({ code: "publication_invalid", status: 400 }),
  );
});

test("trusted checkout selection requires an own exact repository key", () => {
  const inherited = Object.create({ inherited: "/tmp/repo" }) as Record<string, string>;
  expect(() => createGitRevisionVerifier(inherited).assertCommit("inherited", "a".repeat(40))).toThrow(
    PublicationServiceError,
  );
  const malicious = JSON.parse('{"__proto__":"/tmp/repo","constructor":"/tmp/repo","toString":"/tmp/repo"}') as Record<
    string,
    string
  >;
  expect(() => createGitRevisionVerifier(malicious).assertCommit("constructor", "a".repeat(40))).toThrow(
    PublicationServiceError,
  );
});

test("state dictionaries safely retain dangerous property names without inherited reads", async () => {
  const { ownStateValue, safeStateDictionary } = await import("./publication");
  const source = JSON.parse('{"__proto__":{"n":1},"constructor":"c","toString":"t"}') as Record<string, unknown>;
  const safe = safeStateDictionary(source);
  expect(Object.getPrototypeOf(safe)).toBeNull();
  expect(ownStateValue(safe, "__proto__")).toEqual({ n: 1 });
  expect(ownStateValue(safe, "constructor")).toBe("c");
  expect(ownStateValue(safe, "toString")).toBe("t");
  expect(ownStateValue(safe, "missing")).toBeUndefined();
});

const repoIdentity = "company/wagglebot-config";
const revision = "a".repeat(40);
const publicationScope = { kind: "domain" as const, name: "payments" };
const publicationRequest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  operationKey: "publish-one",
  revision,
  repository: repoIdentity,
  path: "company/knowledge/api.md",
  scope: publicationScope,
  owner: "team-payments",
  chunks: [
    {
      chunkKey: "b".repeat(64),
      heading: "# API",
      kind: "convention",
      title: "API",
      content: "Reviewed content",
      confidence: "high",
      wake: false,
      provenance: [
        {
          sourceType: "git",
          actor: "untrusted-request-actor",
          repository: repoIdentity,
          path: "company/knowledge/api.md",
          commitSha: revision,
          capturedAt: "2026-10-18T12:00:00Z",
        },
      ],
    },
  ],
  ...overrides,
});

function firstPublicationChunk() {
  const chunk = publicationRequest().chunks[0];
  if (!chunk) throw new Error("test fixture requires one publication chunk");
  return chunk;
}

function preparationDependencies(overrides: Record<string, unknown> = {}) {
  let scans = 0;
  let embeds = 0;
  const dependencies = {
    sourceKey: sourceKey(repoIdentity, "company/knowledge/api.md", scopeIdentity(publicationScope)),
    raw: publicationRequest(),
    git: { assertCommit() {}, assertFastForward() {} },
    loadCatalog: async () => catalog,
    scanner: {
      async scanPersistedDTO(value: unknown) {
        scans += 1;
        void value;
        return { count: 0 };
      },
    },
    embeddingProvider: {
      async embed() {
        embeds += 1;
        return Array(384).fill(0.1) as number[];
      },
    },
    clock: () => new Date("2026-10-18T12:00:00Z"),
    ...overrides,
  };
  return { dependencies, counts: () => ({ scans, embeds }) };
}

function publicationRepository(initialState: unknown = { operations: {}, sources: {}, reindex: { pending: [] } }) {
  let state: unknown = initialState;
  let rows: Array<Record<string, unknown>> = [];
  let failInsertAt = 0;
  const statements: string[] = [];
  const repository = {
    assertReady: async () => undefined,
    query: async (sql: string) =>
      sql.includes("SELECT worker_state FROM wagglebot_memory_schema_metadata") ? [{ worker_state: state }] : [],
    close: async () => undefined,
    async withTransaction<T>(callback: (tx: { query: typeof query }) => Promise<T>) {
      const originalState = structuredClone(state);
      const originalRows = structuredClone(rows);
      try {
        return await callback({ query });
      } catch (error) {
        state = originalState;
        rows = originalRows;
        throw error;
      }
    },
  };
  async function query(sql: string, values?: unknown[]) {
    statements.push(sql);
    if (sql.includes("SELECT worker_state")) return { rows: [{ worker_state: state }] };
    if (sql.includes("UPDATE wagglebot_memory_schema_metadata")) state = JSON.parse(String(values?.[0]));
    if (sql.includes("SELECT * FROM wagglebot_memories WHERE identity_key"))
      return { rows: rows.filter((row) => row.identity_key === values?.[0]) };
    if (sql.includes("SELECT * FROM wagglebot_memories WHERE id"))
      return { rows: rows.filter((row) => row.id === values?.[0]) };
    if (sql.includes("INSERT INTO wagglebot_memories")) {
      if (failInsertAt > 0 && --failInsertAt === 0) {
        throw new Error("simulated write failure");
      }
      rows.push({
        id: values?.[0],
        canonical_key: values?.[1],
        identity_key: values?.[2],
        kind: values?.[3],
        title: values?.[4],
        text: values?.[5],
        scopes: [values?.[6]],
        embedding: values?.[7],
        confidence: values?.[8],
        provenance: JSON.parse(String(values?.[9])),
        active: true,
        superseded_by: null,
        invalidated_at: null,
        invalidation_reason: null,
        content_hash: values?.[10],
        provenance_count: values?.[11],
        created_at: values?.[12],
        updated_at: values?.[12],
        wake: values?.[13],
        review_after: values?.[14],
        supersedes: values?.[15],
      });
    }
    if (sql.includes("SET active = false, superseded_by = $2")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row) Object.assign(row, { active: false, superseded_by: values?.[1], updated_at: values?.[2] });
    }
    if (sql.includes("SET supersedes = $2 WHERE id = $1")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row) row.supersedes = values?.[1];
    }
    if (sql.includes("SET confidence = $2, provenance = $3")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row)
        Object.assign(row, {
          confidence: values?.[1],
          provenance: JSON.parse(String(values?.[2])),
          provenance_count: values?.[3],
          wake: values?.[4],
          review_after: values?.[5],
          updated_at: values?.[6],
        });
    }
    if (sql.includes("SET title = $2, kind = $3, confidence = $4")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row)
        Object.assign(row, {
          title: values?.[1],
          kind: values?.[2],
          confidence: values?.[3],
          provenance: JSON.parse(String(values?.[4])),
          provenance_count: values?.[5],
          wake: values?.[6],
          review_after: values?.[7],
          embedding: values?.[8],
          updated_at: values?.[9],
        });
    }
    if (sql.includes("SET title = $2, kind = $3, confidence = $4")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row)
        Object.assign(row, {
          title: values?.[1],
          kind: values?.[2],
          confidence: values?.[3],
          provenance: JSON.parse(String(values?.[4])),
          provenance_count: values?.[5],
          wake: values?.[6],
          review_after: values?.[7],
          embedding: values?.[8],
          updated_at: values?.[9],
        });
    }
    if (sql.includes("SET active = false, invalidated_at = $2")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row)
        Object.assign(row, {
          active: false,
          invalidated_at: values?.[1],
          invalidation_reason: values?.[2],
          wake: false,
          updated_at: values?.[1],
        });
    }
    return { rows: [] };
  }
  return {
    repository: repository as unknown as MemoryRepository,
    state: () => structuredClone(state) as Record<string, unknown>,
    rows: () => structuredClone(rows),
    statements,
    failInsertOn: (ordinal: number) => {
      failInsertAt = ordinal;
    },
    setState: (value: unknown) => {
      state = structuredClone(value);
    },
  };
}

function serviceFor(
  repository: MemoryRepository,
  overrides: {
    embeddingProvider?: { embed(value: string): Promise<number[]> };
    scanner?: { scanPersistedDTO(value: unknown): Promise<{ count: number }> };
    loadCatalog?: () => Promise<Catalog>;
    clock?: () => Date;
    git?: {
      assertCommit(repository: string, revision: string): void;
      assertFastForward(repository: string, previous: string, next: string): void;
    };
  } = {},
) {
  const { dependencies } = preparationDependencies({
    sourceKey: "__proto__",
    raw: publicationRequest({ chunks: [{ ...firstPublicationChunk(), chunkKey: "constructor" }] }),
    ...overrides,
  });
  return createPublicationService({
    repository,
    git: (overrides.git ?? dependencies.git) as never,
    loadCatalog: dependencies.loadCatalog as never,
    scanner: dependencies.scanner as never,
    embeddingProvider: dependencies.embeddingProvider as never,
    clock: dependencies.clock as never,
  });
}

test("publication preparation uses source-specific keys and server-derived Git provenance", async () => {
  const { dependencies } = preparationDependencies();
  const prepared = await preparePublication(dependencies);
  expect(prepared.sourceKey).toBe(dependencies.sourceKey);
  expect(prepared.chunks[0]?.identityKey).toMatch(/^publication:[a-f0-9]{64}$/);
  expect(prepared.chunks[0]?.provenance.at(-1)).toMatchObject({
    sourceType: "git",
    actor: "team-payments",
    repository: repoIdentity,
    path: "company/knowledge/api.md",
    commitSha: revision,
    sourceKey: prepared.sourceKey,
  });
  expect(prepared.chunks[0]?.provenance[0]?.actor).not.toBe("untrusted-request-actor");
  expect(prepared.chunks[0]?.provenance[0]?.actor).toBe("team-payments");
});

test("publication scans operation keys on writes and returns replays before scanning", async () => {
  const database = publicationRepository();
  let rejectKeys = false;
  let scans = 0;
  const scanner = {
    async scanPersistedDTO(value: unknown) {
      scans += 1;
      if (rejectKeys && JSON.stringify(value).includes("token:synthetic-credential-value")) return { count: 1 };
      return { count: 0 };
    },
  };
  const service = serviceFor(database.repository, { scanner });
  const first = await service.replaceSource("__proto__", publicationRequest({ operationKey: "publish-clean" }));
  const firstScanCount = scans;
  rejectKeys = true;
  expect(await service.replaceSource("__proto__", publicationRequest({ operationKey: "publish-clean" }))).toEqual(
    first,
  );
  expect(scans).toBe(firstScanCount);
  await expect(
    service.replaceSource(
      "__proto__",
      publicationRequest({ operationKey: "token:synthetic-credential-value", revision: "b".repeat(40) }),
    ),
  ).rejects.toMatchObject({ code: "secret_rejected", status: 422 });
  expect(
    Object.hasOwn(database.state().operations as object, JSON.stringify(["git", "configured-admin", "publish-clean"])),
  ).toBe(true);
  expect(
    Object.hasOwn(
      database.state().operations as object,
      JSON.stringify(["git", "configured-admin", "token:synthetic-credential-value"]),
    ),
  ).toBe(false);
});

test("publication scanner failure rejects a new operation without persisting its key", async () => {
  const database = publicationRepository();
  const service = serviceFor(database.repository, {
    scanner: {
      async scanPersistedDTO() {
        throw new Error("scanner unavailable");
      },
    },
  });
  await expect(
    service.replaceSource("__proto__", publicationRequest({ operationKey: "publish-scanner-failure" })),
  ).rejects.toMatchObject({ code: "scanner_unavailable", status: 503 });
  expect(database.state().operations).toEqual({});
  expect(database.state().sources).toEqual({});
  expect(database.rows()).toEqual([]);
});

test("publication accepts arbitrary source and chunk keys and hashes accepted provenance", async () => {
  const { dependencies } = preparationDependencies({ sourceKey: "__proto__" });
  const request = publicationRequest({ chunks: [{ ...firstPublicationChunk(), chunkKey: "constructor" }] });
  const first = await preparePublication({ ...dependencies, raw: request });
  const sourceChunk = request.chunks[0];
  if (!sourceChunk) throw new Error("test fixture requires one publication chunk");
  const changed = await preparePublication({
    ...dependencies,
    raw: publicationRequest({
      chunks: [
        {
          ...sourceChunk,
          provenance: sourceChunk.provenance.map((item) => ({ ...item, capturedAt: "2026-10-17T00:00:00Z" })),
        },
      ],
    }),
  });
  expect(first.sourceKey).toBe("__proto__");
  expect(first.chunks[0]?.chunkKey).toBe("constructor");
  expect(first.requestHash).not.toBe(changed.requestHash);
  expect(first.bodyHash).not.toBe(changed.bodyHash);
});

test("publication scans the complete prepared batch before calling embeddings", async () => {
  const { dependencies, counts } = preparationDependencies({
    scanner: {
      async scanPersistedDTO() {
        return { count: 1 };
      },
    },
  });
  await expect(preparePublication(dependencies)).rejects.toMatchObject({ code: "secret_rejected" });
  expect(counts().embeds).toBe(0);
});

test("publication embedding failures use the documented memory_unavailable error", async () => {
  const { dependencies } = preparationDependencies({
    embeddingProvider: {
      async embed() {
        throw new Error("provider down");
      },
    },
  });
  await expect(preparePublication(dependencies)).rejects.toMatchObject({
    code: "memory_unavailable",
    status: 503,
  });
});

test("publication rejects a traversal path and accepts an empty complete replacement", async () => {
  const dependencies = preparationDependencies().dependencies;
  await expect(
    preparePublication({
      ...dependencies,
      sourceKey: sourceKey(repoIdentity, "../secret.md", scopeIdentity(publicationScope)),
      raw: publicationRequest({ path: "../secret.md" }),
    }),
  ).rejects.toMatchObject({ code: "publication_invalid" });
  const empty = await preparePublication({
    ...dependencies,
    raw: publicationRequest({ chunks: [] }),
  });
  expect(empty.chunks).toEqual([]);
});

test("source replacement is atomic, retryable, authoritative, and supports a final tombstone", async () => {
  const database = publicationRepository();
  const service = serviceFor(database.repository);
  const chunk = { ...firstPublicationChunk(), chunkKey: "constructor" };
  const firstRequest = publicationRequest({ chunks: [chunk] });
  const first = await service.replaceSource("__proto__", firstRequest);
  expect(first.created).toBe(1);
  expect(database.rows()).toHaveLength(1);
  const insertedId = database.rows()[0]?.id;
  const inserted = database.rows()[0];
  if (!inserted) throw new Error("missing publication row");
  expect((inserted.provenance as Array<Record<string, unknown>>).map((item) => item.actor)).toEqual([
    "team-payments",
    "team-payments",
  ]);
  expect(database.statements.filter((sql) => sql.includes("UPDATE wagglebot_memory_schema_metadata"))).toHaveLength(1);
  const afterFirst = database.state().sources as Record<string, unknown>;
  expect(Object.hasOwn(afterFirst, "__proto__")).toBe(true);
  const firstSource = afterFirst.__proto__ as Record<string, unknown>;
  expect(Object.hasOwn(firstSource.chunks as object, "constructor")).toBe(true);

  const retry = await serviceFor(database.repository).replaceSource("__proto__", firstRequest);
  expect(retry).toEqual(first);
  await expect(
    service.replaceSource(
      "__proto__",
      publicationRequest({
        ...firstRequest,
        chunks: [
          {
            ...chunk,
            provenance: chunk.provenance.map((item) => ({ ...item, capturedAt: "2026-10-17T00:00:00Z" })),
          },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "operation_key_conflict", status: 409 });
  const newOperationNoop = await service.replaceSource(
    "__proto__",
    publicationRequest({
      ...firstRequest,
      operationKey: "publish-retry",
    }),
  );
  expect(newOperationNoop).toMatchObject({ created: 0, updated: 0, invalidated: 0, unchanged: 1 });
  expect(database.rows()[0]?.id).toBe(insertedId);

  await expect(
    service.replaceSource(
      "__proto__",
      publicationRequest({
        operationKey: "different-body-same-revision",
        chunks: [{ ...chunk, content: "Different same-revision body" }],
      }),
    ),
  ).rejects.toMatchObject({ code: "operation_key_conflict", status: 409 });

  const nextRevision = "b".repeat(40);
  const updated = await service.replaceSource(
    "__proto__",
    publicationRequest({
      operationKey: "publish-lower-confidence",
      revision: nextRevision,
      chunks: [{ ...chunk, content: "Changed source text", confidence: "low" }],
    }),
  );
  expect(updated.updated).toBe(1);
  expect(database.rows()).toHaveLength(2);
  expect(database.rows().find((row) => row.active === true)?.confidence).toBe(0);
  expect(database.rows().find((row) => row.id === insertedId)?.superseded_by).toBe(
    database.rows().find((row) => row.active === true)?.id,
  );
  await expect(
    service.replaceSource(
      "__proto__",
      publicationRequest({
        operationKey: "source-path-rebind",
        revision: "d".repeat(40),
        path: "company/knowledge/other.md",
        chunks: [{ ...chunk, content: "Changed source text", confidence: "low" }],
      }),
    ),
  ).rejects.toMatchObject({ code: "operation_key_conflict", status: 409 });
  await expect(
    service.replaceSource(
      "__proto__",
      publicationRequest({
        operationKey: "older-revision",
        revision,
      }),
    ),
  ).rejects.toMatchObject({ code: "source_revision_regressed", status: 409 });

  const tombstone = await service.replaceSource(
    "__proto__",
    publicationRequest({
      operationKey: "publish-empty",
      revision: "c".repeat(40),
      chunks: [],
    }),
  );
  expect(tombstone.invalidated).toBe(1);
  expect(database.rows().every((row) => row.active === false)).toBe(true);
  const sourceMap = database.state().sources as Record<string, unknown>;
  expect(Object.hasOwn(sourceMap, "__proto__")).toBe(true);
  expect(Object.keys((sourceMap.__proto__ as Record<string, unknown>).chunks as object)).toEqual([]);
});

test("removing a published chunk cancels its claimed reindex and records failed run progress", async () => {
  const database = publicationRepository();
  const service = serviceFor(database.repository);
  const published = await service.replaceSource(
    "source-for-cancel",
    publicationRequest({ operationKey: "publish-before-cancel" }),
  );
  const row = database.rows()[0];
  if (!row) throw new Error("publication should create a memory row");
  const queued = enqueueReindex(
    database.state(),
    [{ id: String(row.id), contentHash: String(row.content_hash) }],
    "reindex",
  );
  const claimed = startRun(queued.state, {
    operationKey: "publication-cancel-run",
    requestHash: "publication-cancel-hash",
    operationId: "publication-cancel-id",
    limit: 1,
    now: new Date("2026-10-18T12:00:00.000Z"),
    token: () => "publication-cancel-token",
  });
  if (claimed.kind !== "started") throw new Error("reindex should claim the published record");
  database.setState(claimed.state);

  const tombstone = await service.replaceSource(
    "source-for-cancel",
    publicationRequest({ operationKey: "publish-removal", revision: "d".repeat(40), chunks: [] }),
  );
  expect(tombstone.invalidated).toBe(1);
  const state = database.state() as {
    reindex: { pending: unknown[]; runs: Record<string, { progress: { failed: number }; finalized: boolean }> };
  };
  expect(state.reindex.pending).toEqual([]);
  expect(state.reindex.runs[claimed.runKey]).toMatchObject({ progress: { failed: 1 }, finalized: true });
  expect(published.created).toBe(1);
});

test("a later chunk failure rolls back prior records and source state", async () => {
  const database = publicationRepository();
  database.failInsertOn(2);
  const service = serviceFor(database.repository);
  const twoChunks = publicationRequest({
    chunks: [
      { ...publicationRequest().chunks[0], chunkKey: "first-chunk" },
      { ...publicationRequest().chunks[0], chunkKey: "second-chunk", title: "Second chunk", content: "Another fact" },
    ],
  });
  await expect(service.replaceSource("__proto__", twoChunks)).rejects.toThrow("simulated write failure");
  expect(database.rows()).toEqual([]);
  expect(database.state()).toEqual({ operations: {}, sources: {}, reindex: { pending: [] } });
  expect(database.statements.some((sql) => sql.includes("UPDATE wagglebot_memory_schema_metadata"))).toBe(false);
});

test("successful publication replay bypasses expired review and changed catalog source ownership", async () => {
  const database = publicationRepository();
  let currentTime = new Date("2026-10-18T12:00:00.000Z");
  const request = publicationRequest({
    chunks: [{ ...firstPublicationChunk(), wake: true, reviewAfter: "2026-10-19" }],
  });
  const first = await serviceFor(database.repository, { clock: () => currentTime }).replaceSource("source", request);
  const statementsBeforeRetry = database.statements.length;
  currentTime = new Date("2026-10-20T12:00:00.000Z");
  let scans = 0;
  let embeddings = 0;
  const changedCatalog: Catalog = {
    ...catalog,
    domains: [{ name: "payments", owner: "team-new-owner" }],
  };
  const retry = await serviceFor(database.repository, {
    clock: () => currentTime,
    loadCatalog: async () => changedCatalog,
    scanner: {
      async scanPersistedDTO() {
        scans += 1;
        return { count: 0 };
      },
    },
    embeddingProvider: {
      async embed() {
        embeddings += 1;
        return Array(384).fill(0.2);
      },
    },
  }).replaceSource("source", request);
  expect(retry).toEqual(first);
  expect(database.statements).toHaveLength(statementsBeforeRetry);
  expect(scans).toBe(0);
  expect(embeddings).toBe(0);
});

test("publication locked replay wins over owner and Git changes after an early lookup miss", async () => {
  const database = publicationRepository();
  const request = publicationRequest();
  let currentCatalog = catalog;
  let sourceDataChanged = false;
  let nesting = false;
  let nestedResult: PublicationResponse | undefined;
  let service: ReturnType<typeof serviceFor>;
  const git = {
    assertCommit() {
      if (sourceDataChanged) throw new Error("commit no longer available");
    },
    assertFastForward() {},
  };
  const embeddingProvider = {
    async embed() {
      if (!nesting) {
        nesting = true;
        nestedResult = await service.replaceSource("source", request);
        currentCatalog = { ...catalog, domains: [{ name: "payments", owner: "new-owner" }] };
        sourceDataChanged = true;
      }
      return Array(384).fill(0.1);
    },
  };
  service = serviceFor(database.repository, {
    git,
    loadCatalog: async () => currentCatalog,
    embeddingProvider,
  });
  const result = await service.replaceSource("source", request);
  if (!nestedResult) throw new Error("nested publication must succeed before outer replay");
  expect(result).toEqual(nestedResult);
  expect(database.rows()).toHaveLength(1);
});

test("same-content publication refreshes authoritative title, kind, and embedding", async () => {
  const database = publicationRepository();
  const initialService = serviceFor(database.repository);
  const chunk = { ...firstPublicationChunk(), chunkKey: "stable-chunk" };
  await initialService.replaceSource("source", publicationRequest({ chunks: [chunk] }));
  const original = database.rows()[0];
  expect(original?.embedding).toBe(`[${Array(384).fill(0.1).join(",")}]`);

  const refreshed = serviceFor(database.repository, {
    embeddingProvider: {
      async embed() {
        return Array(384).fill(0.2);
      },
    },
  });
  const result = await refreshed.replaceSource(
    "source",
    publicationRequest({
      operationKey: "publish-metadata-update",
      revision: "b".repeat(40),
      chunks: [{ ...chunk, title: "Operations API", kind: "fact" }],
    }),
  );
  expect(result.updated).toBe(1);
  expect(database.rows()).toHaveLength(1);
  expect(database.rows()[0]).toMatchObject({
    id: original?.id,
    title: "Operations API",
    kind: "fact",
    embedding: `[${Array(384).fill(0.2).join(",")}]`,
  });
});
