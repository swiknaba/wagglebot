import { type MemoryRecord, MemoryRecordSchema } from "../../contracts/src/memory";

type DbRow = Record<string, unknown>;

function dateTime(value: unknown, field: string): string {
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const utcRaw = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const date = new Date(utcRaw);
  if (!Number.isFinite(date.getTime())) throw new Error(`unsupported legacy memory row: invalid ${field}`);
  return date.toISOString();
}

function scope(scopes: unknown): MemoryRecord["scope"] {
  if (!Array.isArray(scopes) || scopes.length !== 1 || typeof scopes[0] !== "string") {
    throw new Error("unsupported legacy memory row: expected exactly one scope");
  }
  const raw = scopes[0];
  if (raw === "org") return { kind: "org" };
  const separator = raw.indexOf(":");
  if (separator < 1) throw new Error("unsupported legacy memory row: unsupported scope");
  const kind = raw.slice(0, separator);
  const name = raw.slice(separator + 1);
  if ((kind !== "system" && kind !== "domain") || !name) {
    throw new Error("unsupported legacy memory row: unsupported scope");
  }
  return { kind, name } as MemoryRecord["scope"];
}

function confidence(value: unknown): MemoryRecord["confidence"] {
  if (value === 0) return "low";
  if (value === 0.5) return "medium";
  if (value === 1) return "high";
  throw new Error("unsupported legacy memory row: confidence must be 0, 0.5, or 1");
}

function provenance(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("unsupported legacy memory row: invalid provenance");
    }
  }
  return value;
}

export function decodeMemoryRecord(row: DbRow): MemoryRecord {
  const active = row.active;
  const invalidatedAt = row.invalidated_at;
  const supersededBy = row.superseded_by;
  let status: MemoryRecord["status"];
  if (active === true) {
    if (invalidatedAt != null || supersededBy != null)
      throw new Error("unsupported legacy memory row: contradictory lifecycle fields");
    status = "active";
  } else if (active === false && invalidatedAt != null) {
    status = "invalidated";
  } else if (active === false && invalidatedAt == null && supersededBy != null) {
    status = "superseded";
  } else {
    throw new Error("unsupported legacy memory row: contradictory lifecycle fields");
  }

  const mapped = {
    id: row.id,
    schemaVersion: 1,
    scope: scope(row.scopes),
    kind: row.kind,
    title: row.title,
    content: row.text,
    canonicalKey: row.canonical_key,
    identityKey: row.identity_key,
    contentHash: row.content_hash,
    confidence: confidence(row.confidence),
    status,
    wake: row.wake,
    ...(row.review_after == null
      ? {}
      : {
          reviewAfter:
            typeof row.review_after === "string"
              ? row.review_after.slice(0, 10)
              : dateTime(row.review_after, "review_after").slice(0, 10),
        }),
    provenance: provenance(row.provenance),
    ...(supersededBy == null ? {} : { supersededBy }),
    ...(row.supersedes == null ? {} : { supersedes: row.supersedes }),
    createdAt: dateTime(row.created_at, "created_at"),
    updatedAt: dateTime(row.updated_at, "updated_at"),
  };
  const result = MemoryRecordSchema.safeParse(mapped);
  if (!result.success) throw new Error("unsupported legacy memory row: fields do not match the memory contract");
  return result.data;
}

export const toMemoryRecord = decodeMemoryRecord;
