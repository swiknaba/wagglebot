import { expect, test } from "bun:test";
import {
  EvidenceRefSchema,
  PacketMetadataSchema,
  ProjectIdentitySchema,
  ProvenanceSchema,
  ProviderFailureSchema,
  RelativePathSchema,
  SharedScopeSchema,
} from "./index";

const sha256 = "a".repeat(64);
const gitSha = "b".repeat(40);

test("project identity is strict while allowing its documented optional fields", () => {
  expect(
    ProjectIdentitySchema.safeParse({
      component: "catalog-cli",
      system: "tooling",
      workingTree: "clean",
      catalogState: "resolved",
    }).success,
  ).toBe(true);
  expect(
    ProjectIdentitySchema.safeParse({
      workingTree: "clean",
      catalogState: "resolved",
      unexpected: true,
    }).success,
  ).toBe(false);
});

test("relative paths reject absolute, traversal, unnormalized, secret, and NUL paths", () => {
  expect(RelativePathSchema.safeParse("src/contracts/base.ts").success).toBe(true);
  for (const path of [
    "/workspace/src/base.ts",
    "../src/base.ts",
    "src/../base.ts",
    "src//base.ts",
    ".env.local",
    "certificates/server.pem",
    "keys/service.key",
    "credentials/store.json",
    "secrets/store.json",
    "src\u0000/base.ts",
  ]) {
    expect(RelativePathSchema.safeParse(path).success).toBe(false);
  }
});

test("evidence references require ordered line ranges, safe paths, and lowercase hashes", () => {
  expect(
    EvidenceRefSchema.safeParse({
      kind: "local_memory",
      path: ".agents/memory.md",
      startLine: 4,
      endLine: 4,
      contentHash: sha256,
    }).success,
  ).toBe(true);
  expect(
    EvidenceRefSchema.safeParse({
      kind: "code",
      path: "src/base.ts",
      startLine: 6,
      endLine: 5,
      graphState: "ready",
    }).success,
  ).toBe(false);
  expect(
    EvidenceRefSchema.safeParse({
      kind: "git",
      commit: "B".repeat(40),
      path: "/outside.ts",
    }).success,
  ).toBe(false);
  expect(
    EvidenceRefSchema.safeParse({
      kind: "shared_memory",
      memoryId: "018f5f5e-69a7-7f86-8f40-f8f31f8cfa61",
      commitSha: gitSha,
      extra: "rejected",
    }).success,
  ).toBe(false);
});

test("evidence references reject line numbers above the Phase 0 maximum", () => {
  const valid = {
    kind: "code",
    path: "src/base.ts",
    startLine: 1_000_000,
    endLine: 1_000_000,
    graphState: "ready",
  };
  expect(EvidenceRefSchema.safeParse(valid).success).toBe(true);
  expect(EvidenceRefSchema.safeParse({ ...valid, startLine: 1_000_001 }).success).toBe(false);
  expect(EvidenceRefSchema.safeParse({ ...valid, endLine: 1_000_001 }).success).toBe(false);
});

test("provenance rejects malformed timestamps, unsafe paths, unknown fields, and non-full commit hashes", () => {
  const valid = {
    sourceType: "git",
    actor: "memory-publisher",
    repository: "example/contracts",
    path: "docs/contract.md",
    commitSha: gitSha,
    capturedAt: "2026-09-12T12:00:00.000Z",
  };
  expect(ProvenanceSchema.safeParse(valid).success).toBe(true);
  expect(ProvenanceSchema.safeParse({ ...valid, capturedAt: "2026-09-12 12:00:00" }).success).toBe(false);
  expect(ProvenanceSchema.safeParse({ ...valid, path: "secrets/key.txt" }).success).toBe(false);
  expect(ProvenanceSchema.safeParse({ ...valid, commitSha: "b".repeat(39) }).success).toBe(false);
  expect(ProvenanceSchema.safeParse({ ...valid, unknown: true }).success).toBe(false);
});

test("provenance and packet metadata reject RFC3339 timestamps above the Phase 0 maximum", () => {
  const maximumTimestamp = `2026-09-12T12:00:00.${"1".repeat(43)}Z`;
  const oversizedTimestamp = `2026-09-12T12:00:00.${"1".repeat(44)}Z`;
  const provenance = {
    sourceType: "git",
    actor: "memory-publisher",
    capturedAt: maximumTimestamp,
  };
  const metadata = {
    schemaVersion: 1,
    packetId: "ctx_0123456789abcdef",
    generatedAt: maximumTimestamp,
    estimatedTokens: 1,
  };

  expect(ProvenanceSchema.safeParse(provenance).success).toBe(true);
  expect(PacketMetadataSchema.safeParse(metadata).success).toBe(true);
  expect(ProvenanceSchema.safeParse({ ...provenance, capturedAt: oversizedTimestamp }).success).toBe(false);
  expect(PacketMetadataSchema.safeParse({ ...metadata, generatedAt: oversizedTimestamp }).success).toBe(false);
});

test("shared scopes permit only lower-case system, domain, and org variants", () => {
  expect(SharedScopeSchema.safeParse({ kind: "system", name: "payments-api" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "domain", name: "commerce" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "org" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "component", name: "payments-api" }).success).toBe(false);
  expect(SharedScopeSchema.safeParse({ kind: "system", name: "Payments" }).success).toBe(false);
  expect(SharedScopeSchema.safeParse({ kind: "org", name: "example" }).success).toBe(false);
});

test("provider failures allow only stable codes and non-negative elapsed time", () => {
  expect(ProviderFailureSchema.safeParse({ provider: "git", code: "timeout", elapsedMs: 0 }).success).toBe(true);
  expect(ProviderFailureSchema.safeParse({ provider: "git", code: "raw_error", elapsedMs: 1 }).success).toBe(false);
  expect(ProviderFailureSchema.safeParse({ provider: "git", code: "timeout", elapsedMs: -1 }).success).toBe(false);
});

test("packet metadata is strict, timestamped, and bounded to the documented hard token maximum", () => {
  const valid = {
    schemaVersion: 1,
    packetId: "ctx_0123456789abcdef",
    generatedAt: "2026-09-12T12:00:00.000Z",
    gitHead: gitSha,
    branch: "DEV-001",
    estimatedTokens: 5_000,
  };
  expect(PacketMetadataSchema.safeParse(valid).success).toBe(true);
  expect(PacketMetadataSchema.safeParse({ ...valid, estimatedTokens: 5_001 }).success).toBe(false);
  expect(PacketMetadataSchema.safeParse({ ...valid, generatedAt: "not-a-timestamp" }).success).toBe(false);
  expect(PacketMetadataSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  expect(PacketMetadataSchema.safeParse({ ...valid, item: "not metadata" }).success).toBe(false);
});
