import { describe, expect, test } from "bun:test";
import { decodeMemoryRecord } from "./record-mapping";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  canonical_key: "system:payments:retry-window",
  identity_key: "payments:retry-window",
  kind: "decision",
  title: "Retry window",
  text: "Retry for five minutes.",
  scopes: ["system:payments"],
  confidence: 0.5,
  tags: [],
  provenance: [{ sourceType: "git", actor: "team-payments", capturedAt: "2026-10-06T10:00:00Z" }],
  active: true,
  superseded_by: null,
  invalidated_at: null,
  content_hash: "a".repeat(64),
  created_at: new Date("2026-10-06T10:00:00Z"),
  updated_at: new Date("2026-10-06T10:00:00Z"),
  wake: false,
  review_after: null,
  supersedes: null,
} as const;

describe("database memory record mapping", () => {
  test("maps a supported row into the public contract", () => {
    expect(decodeMemoryRecord(row)).toEqual({
      id: row.id,
      schemaVersion: 1,
      scope: { kind: "system", name: "payments" },
      kind: "decision",
      title: row.title,
      content: row.text,
      canonicalKey: row.canonical_key,
      identityKey: row.identity_key,
      contentHash: row.content_hash,
      confidence: "medium",
      status: "active",
      wake: false,
      provenance: [...row.provenance],
      createdAt: "2026-10-06T10:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
    });
  });

  test("rejects unsupported scope shapes and contradictory lifecycle columns", () => {
    expect(() => decodeMemoryRecord({ ...row, scopes: ["system:payments", "org"] })).toThrow(/scope/i);
    expect(() =>
      decodeMemoryRecord({ ...row, active: true, superseded_by: "22222222-2222-4222-8222-222222222222" }),
    ).toThrow(/lifecycle/i);
  });

  test("maps wake review and supersession fields", () => {
    expect(
      decodeMemoryRecord({
        ...row,
        wake: true,
        review_after: "2026-11-06",
        supersedes: "22222222-2222-4222-8222-222222222222",
      }),
    ).toMatchObject({
      wake: true,
      reviewAfter: "2026-11-06",
      supersedes: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("keeps invalidation status when historical supersession links also exist", () => {
    expect(
      decodeMemoryRecord({
        ...row,
        active: false,
        invalidated_at: new Date("2026-10-06T11:00:00Z"),
        superseded_by: "22222222-2222-4222-8222-222222222222",
      }),
    ).toMatchObject({ status: "invalidated", supersededBy: "22222222-2222-4222-8222-222222222222" });
  });

  test("interprets legacy timestamp wall times and PostgreSQL dates as UTC values", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      expect(
        decodeMemoryRecord({
          ...row,
          created_at: "2026-03-29 00:30:00",
          updated_at: "2026-03-29 00:30:00",
          wake: true,
          review_after: "2026-03-29",
        }),
      ).toMatchObject({
        createdAt: "2026-03-29T00:30:00.000Z",
        reviewAfter: "2026-03-29",
      });
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
