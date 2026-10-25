import { expect, test } from "bun:test";
import { REINDEX_MAX_ATTEMPTS, readAdminState, readSourceState } from "./state";

const empty = () => ({ operations: {}, sources: {}, reindex: { pending: [] } });
const source = () => ({
  repository: "company",
  path: "knowledge.md",
  scope: { kind: "org" },
  owner: "owner",
  currentRevision: "a".repeat(40),
  bodyHash: "b".repeat(64),
  revisions: ["a".repeat(40)],
  chunks: { intro: "7101cc0e-6a04-503b-8d23-329b99cff42f" },
});

test("admin parsing initializes runs without mutating input and preserves extension fields", () => {
  const input = { ...empty(), extension: "kept", reindex: { pending: [], extension: 1 } };
  const parsed = readAdminState(input);
  expect(parsed.reindex.runs).toEqual({});
  expect(parsed.extension).toBe("kept");
  expect(parsed.reindex.extension).toBe(1);
  expect(input.reindex).not.toHaveProperty("runs");
  expect(readAdminState(JSON.stringify(input))).toEqual(parsed);
});

test("admin validation rejects duplicate or exhausted pending entries with a content-free error", () => {
  for (const pending of [
    [{ id: "private-id", contentHash: "private-hash", attempts: REINDEX_MAX_ATTEMPTS + 1 }],
    [
      { id: "private-id", contentHash: "private-hash", attempts: 0 },
      { id: "private-id", contentHash: "private-hash", attempts: 0 },
    ],
  ]) {
    expect(() => readAdminState({ ...empty(), reindex: { pending } })).toThrow("invalid_memory_state");
  }
  expect(() => readAdminState("private-invalid-json")).toThrow("invalid_memory_state");
});

test("admin claims must link both ways and finalized progress must match claim statuses", () => {
  const expiresAt = "2026-01-01T00:00:00Z";
  const input = {
    ...empty(),
    reindex: {
      pending: [{ id: "id", contentHash: "hash", attempts: 1, claim: { token: "token", expiresAt, runKey: "run" } }],
      runs: {
        run: {
          requestHash: "hash",
          operationId: "operation",
          expiresAt,
          claims: [{ id: "id", contentHash: "hash", token: "token", status: "claimed" as const }],
          progress: { claimed: 1, completed: 0, failed: 0 },
          finalized: false,
        },
      },
    },
  };
  expect(readAdminState(input)).toEqual(input);
  input.reindex.runs.run.finalized = true;
  expect(() => readAdminState(input)).toThrow("invalid_memory_state");
  input.reindex.runs.run.finalized = false;
  const claim = input.reindex.runs.run.claims[0];
  if (!claim) throw new Error("expected claim");
  claim.token = "other";
  expect(() => readAdminState(input)).toThrow("invalid_memory_state");
});

test("source parsing copies revision and own chunk data safely", () => {
  const input = source();
  const chunks = Object.create({ inherited: "invalid-id" });
  Object.defineProperty(chunks, "__proto__", { value: input.chunks.intro, enumerable: true });
  input.chunks = chunks;
  const parsed = readSourceState({ ...input, extension: true });
  expect(Object.getPrototypeOf(parsed.chunks)).toBeNull();
  expect(parsed.chunks.__proto__).toBe(source().chunks.intro);
  expect(Object.hasOwn(parsed.chunks, "inherited")).toBe(false);
  expect(parsed.revisions).not.toBe(input.revisions);
});

test("source validation rejects regressed history and malformed identifiers safely", () => {
  for (const input of [
    { ...source(), revisions: ["a".repeat(40), "a".repeat(40)] },
    { ...source(), revisions: ["a".repeat(40), "c".repeat(40)] },
    { ...source(), chunks: { intro: "private-invalid-id" } },
    { ...source(), scope: { kind: "private-invalid-scope" } },
  ])
    expect(() => readSourceState(input)).toThrow("invalid_memory_state");
});
