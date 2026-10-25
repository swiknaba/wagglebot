import { RelativePathSchema, Rfc3339TimestampSchema } from "../../contracts/src/base";
import {
  AdminReindexResponseSchema,
  AdminRescanResponseSchema,
  AdminRunOnceResponseSchema,
  InvalidateResponseSchema,
  PublicationRequestSchema,
  PublicationResponseSchema,
  WriteResultSchema,
} from "../../contracts/src/memory";
import { decodeMemoryRecord } from "./record-mapping";
import { ADMIN_EMBEDDING_PROFILE_ID, readAdminState, readSourceState } from "./state";

type Dictionary = Record<string, unknown>;
type Manifest = { latest: string; migrations: string[] };
export type MemorySnapshot = {
  schemaVersion: 1;
  embeddingProfileId: string;
  migrationManifest: Manifest;
  tables: {
    wagglebot_memories: Dictionary[];
    wagglebot_memory_schema_metadata: Dictionary[];
    wagglebot_schema_migrations: { filename: string }[];
  };
};

const memoryColumns = [
  "id",
  "canonical_key",
  "identity_key",
  "kind",
  "title",
  "text",
  "scopes",
  "embedding",
  "confidence",
  "tags",
  "provenance",
  "active",
  "superseded_by",
  "invalidated_at",
  "invalidation_reason",
  "content_hash",
  "provenance_count",
  "created_at",
  "updated_at",
  "wake",
  "review_after",
  "supersedes",
];
const metadataColumns = ["provider", "model", "dimension", "distance", "schema_version", "created_at", "worker_state"];
const hash = /^[a-f0-9]{64}$/u;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const operationKey = /^[A-Za-z0-9._:-]{1,128}$/u;

function invalid(): never {
  throw new Error("invalid memory snapshot");
}
function object(value: unknown): Dictionary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Dictionary;
}
function exact(value: unknown, required: string[], optional: string[] = []): Dictionary {
  const record = object(value);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid();
  return record;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) return invalid();
  return value;
}
function pattern(value: unknown, expression: RegExp): string {
  const result = text(value);
  if (!expression.test(result)) return invalid();
  return result;
}
function utc(value: unknown): void {
  if (typeof value !== "string" || !value.endsWith("Z") || !Rfc3339TimestampSchema.safeParse(value).success) invalid();
}

function actorTuple(key: string): string[] {
  const tuple: unknown = JSON.parse(key);
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    tuple.some((part) => typeof part !== "string" || !part) ||
    JSON.stringify(tuple) !== key
  )
    return invalid();
  if (!["human", "agent", "git", "operator"].includes(tuple[0]) || !operationKey.test(tuple[2])) return invalid();
  if (tuple[0] === "operator" && tuple[1] !== "configured-admin") return invalid();
  return tuple as string[];
}

function validateState(raw: unknown): void {
  const state = exact(raw, ["operations", "sources", "reindex"]);
  for (const [key, rawEntry] of Object.entries(object(state.operations))) {
    const tuple = actorTuple(key);
    const entry = exact(rawEntry, ["requestHash", "result"]);
    pattern(entry.requestHash, hash);
    const schemas =
      tuple[0] === "operator"
        ? [AdminReindexResponseSchema, AdminRescanResponseSchema, AdminRunOnceResponseSchema]
        : tuple[0] === "git"
          ? [PublicationResponseSchema]
          : tuple[0] === "agent"
            ? [WriteResultSchema]
            : [WriteResultSchema, InvalidateResponseSchema];
    if (
      !schemas.some((schema) => schema.safeParse(entry.result).success) ||
      object(entry.result).operationKey !== tuple[2]
    )
      invalid();
  }
  for (const [key, source] of Object.entries(object(state.sources))) {
    text(key);
    exact(source, ["repository", "path", "scope", "owner", "currentRevision", "bodyHash", "revisions", "chunks"]);
    const parsed = readSourceState(source);
    PublicationRequestSchema.shape.repository.parse(parsed.repository);
    PublicationRequestSchema.shape.owner.parse(parsed.owner);
    if (!RelativePathSchema.safeParse(parsed.path).success) invalid();
  }
  const reindex = exact(state.reindex, ["pending"], ["runs", "lastOperationKey"]);
  if (reindex.lastOperationKey !== undefined) pattern(reindex.lastOperationKey, operationKey);
  for (const rawEntry of rows(reindex.pending)) {
    const entry = exact(rawEntry, ["id", "contentHash", "attempts"], ["claim"]);
    pattern(entry.id, uuid);
    pattern(entry.contentHash, hash);
    if (entry.claim !== undefined) {
      const claim = exact(entry.claim, ["token", "expiresAt", "runKey"]);
      text(claim.token);
      utc(claim.expiresAt);
      actorTuple(text(claim.runKey));
    }
  }
  if (reindex.runs !== undefined)
    for (const [key, rawRun] of Object.entries(object(reindex.runs))) {
      if (actorTuple(key)[0] !== "operator") invalid();
      const run = exact(rawRun, ["requestHash", "operationId", "expiresAt", "claims", "progress", "finalized"]);
      pattern(run.requestHash, hash);
      text(run.operationId);
      utc(run.expiresAt);
      exact(run.progress, ["claimed", "completed", "failed"]);
      for (const rawClaim of rows(run.claims)) {
        const claim = exact(rawClaim, ["id", "contentHash", "token", "status"]);
        pattern(claim.id, uuid);
        pattern(claim.contentHash, hash);
        text(claim.token);
      }
    }
  readAdminState(state);
}

export function validateSnapshot(value: unknown, expected: Manifest): MemorySnapshot {
  try {
    const snapshot = exact(value, ["schemaVersion", "embeddingProfileId", "migrationManifest", "tables"]);
    if (snapshot.schemaVersion !== 1 || snapshot.embeddingProfileId !== ADMIN_EMBEDDING_PROFILE_ID) return invalid();
    const manifest = exact(snapshot.migrationManifest, ["latest", "migrations"]);
    if (
      manifest.latest !== expected.latest ||
      JSON.stringify(manifest.migrations) !== JSON.stringify(expected.migrations)
    )
      return invalid();
    const tables = exact(snapshot.tables, [
      "wagglebot_memories",
      "wagglebot_memory_schema_metadata",
      "wagglebot_schema_migrations",
    ]);
    const migrations = rows(tables.wagglebot_schema_migrations).map((row) => text(exact(row, ["filename"]).filename));
    if (JSON.stringify(migrations) !== JSON.stringify(expected.migrations)) return invalid();
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const raw of rows(tables.wagglebot_memories)) {
      const row = exact(raw, memoryColumns);
      const record = decodeMemoryRecord(row);
      if (ids.has(record.id) || keys.has(record.canonicalKey)) return invalid();
      ids.add(record.id);
      keys.add(record.canonicalKey);
      if (
        !Array.isArray(row.embedding) ||
        row.embedding.length !== 384 ||
        row.embedding.some((number) => typeof number !== "number" || !Number.isFinite(number))
      )
        return invalid();
      if (!Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== "string")) return invalid();
      if (!Array.isArray(row.provenance) || row.provenance_count !== row.provenance.length) return invalid();
      if (row.invalidation_reason !== null && typeof row.invalidation_reason !== "string") return invalid();
      utc(row.created_at);
      utc(row.updated_at);
      if (row.invalidated_at !== null) utc(row.invalidated_at);
      if (
        row.review_after !== null &&
        (typeof row.review_after !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(row.review_after))
      )
        return invalid();
      for (const name of ["supersedes", "superseded_by"]) if (row[name] !== null) pattern(row[name], uuid);
    }
    const metadata = rows(tables.wagglebot_memory_schema_metadata);
    if (metadata.length !== 1) return invalid();
    const profile = exact(metadata[0], metadataColumns);
    if (
      profile.provider !== "xenova-transformers" ||
      profile.model !== "all-MiniLM-L6-v2" ||
      profile.dimension !== 384 ||
      profile.distance !== "cosine" ||
      profile.schema_version !== 1
    )
      return invalid();
    utc(profile.created_at);
    validateState(profile.worker_state);
    return value as MemorySnapshot;
  } catch {
    return invalid();
  }
}

/** Keep scans bounded to one stored record or coordination entry, never an entire archive. */
export function* snapshotScanUnits(snapshot: MemorySnapshot): Generator<unknown> {
  for (const row of snapshot.tables.wagglebot_memories) {
    const { embedding: _embedding, ...material } = row;
    yield material;
  }
  for (const profile of snapshot.tables.wagglebot_memory_schema_metadata) {
    const { worker_state, ...material } = profile;
    yield material;
    const state = object(worker_state);
    for (const name of ["operations", "sources"])
      for (const [key, value] of Object.entries(object(state[name]))) yield { key, value };
    const reindex = object(state.reindex);
    if (reindex.lastOperationKey !== undefined) yield { lastOperationKey: reindex.lastOperationKey };
    for (const entry of rows(reindex.pending)) yield entry;
    for (const [key, value] of Object.entries(object(reindex.runs ?? {}))) yield { key, value };
  }
}
