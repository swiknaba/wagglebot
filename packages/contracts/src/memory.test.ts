import { expect, test } from "bun:test";
import * as memory from "./memory";
import {
  MemoryErrorCodeSchema,
  MemoryProposalRequestSchema,
  MemoryRecordSchema,
  MemorySearchInputSchema,
  MemorySearchResultSchema,
  PublicationRequestSchema,
  RememberRequestSchema,
  SharedScopeSchema,
  WriteResultSchema,
} from "./memory";
import { PrincipalSchema } from "./principal";

const uuid = "018f5f5e-69a7-7f86-8f40-f8f31f8cfa61";
const gitSha = "b".repeat(40);
const hash = "a".repeat(64);

const provenance = {
  sourceType: "git" as const,
  actor: "memory-publisher",
  repository: "company/wagglebot-config",
  path: "company/knowledge/api.md",
  commitSha: gitSha,
  heading: "Compatibility",
  sourceKey: "wglsrc_123",
  capturedAt: "2026-09-12T10:00:00.000Z",
};

const record = (overrides: Record<string, unknown> = {}) => ({
  id: uuid,
  schemaVersion: 1,
  scope: { kind: "domain", name: "payments" },
  kind: "convention",
  title: "API compatibility",
  content: "Keep one prior API version available.",
  canonicalKey: "git:source:heading:0",
  identityKey: "git:source:heading:0",
  contentHash: hash,
  confidence: "high",
  status: "active",
  wake: false,
  provenance: [provenance],
  createdAt: "2026-09-12T10:00:00.000Z",
  updatedAt: "2026-09-12T10:00:00.000Z",
  ...overrides,
});

const publicationChunk = (ordinal: number) => ({
  chunkKey: `chunk_${ordinal}`,
  heading: "Compatibility",
  kind: "convention" as const,
  title: "API compatibility",
  content: "Keep one prior API version available.",
  confidence: "high" as const,
  wake: false,
  provenance: [provenance],
});

test("shared scopes exclude component memory and reject unknown fields", () => {
  expect(SharedScopeSchema.safeParse({ kind: "system", name: "payments" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "org" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "component", name: "pay-api" }).success).toBe(false);
  expect(SharedScopeSchema.safeParse({ kind: "org", extra: true }).success).toBe(false);
});

test("memory records require immutable provenance and bounded wake metadata", () => {
  expect(MemoryRecordSchema.safeParse(record({ wake: true })).success).toBe(false);
  expect(MemoryRecordSchema.safeParse(record({ wake: true, reviewAfter: "2027-03-01" })).success).toBe(true);
  expect(MemoryRecordSchema.safeParse(record({ reviewAfter: "2026-02-30" })).success).toBe(false);
  expect(MemoryRecordSchema.safeParse({ ...record(), unexpected: true }).success).toBe(false);
});

test("record title and content limits count Unicode code points", () => {
  expect(MemoryRecordSchema.safeParse(record({ title: "😀".repeat(200) })).success).toBe(true);
  expect(MemoryRecordSchema.safeParse(record({ title: "😀".repeat(201) })).success).toBe(false);
  expect(MemoryRecordSchema.safeParse(record({ content: "😀".repeat(4_000) })).success).toBe(true);
  expect(MemoryRecordSchema.safeParse(record({ content: "😀".repeat(4_001) })).success).toBe(false);
});

test("query and wake searches are strict and have separate bounds", () => {
  const query = MemorySearchInputSchema.parse({
    schemaVersion: 1,
    purpose: "query",
    query: "how does token rotation work",
    cascade: { component: "payments-api", system: "payments", domain: "commerce", includeOrg: true },
  });
  expect(query.limit).toBe(10);

  const wake = MemorySearchInputSchema.parse({
    schemaVersion: 1,
    purpose: "wake",
    cascade: { system: "payments", domain: "commerce", includeOrg: true },
  });
  expect(wake.limit).toBe(3);
  expect(MemorySearchInputSchema.safeParse({ ...query, purpose: "wake", query: "not allowed" }).success).toBe(false);
  expect(
    MemorySearchInputSchema.safeParse({
      ...query,
      cascade: { system: "payments", domain: "commerce", includeOrg: false },
    }).success,
  ).toBe(false);
  expect(MemorySearchInputSchema.safeParse({ ...query, query: "😀".repeat(2_001) }).success).toBe(false);
});

test("remember defaults wake to false and requires review metadata when enabled", () => {
  const input = {
    schemaVersion: 1,
    operationKey: "op_remember",
    scope: { kind: "system", name: "payments" },
    kind: "decision",
    title: "Use PostgreSQL",
    content: "Use the shared PostgreSQL control store.",
    confidence: "high",
    provenance: [provenance],
  };
  expect(RememberRequestSchema.parse(input).wake).toBe(false);
  expect(RememberRequestSchema.safeParse({ ...input, wake: true }).success).toBe(false);
  expect(RememberRequestSchema.safeParse({ ...input, wake: true, reviewAfter: "2027-03-01" }).success).toBe(true);
});

test("agent proposals are system-only and capped at twenty facts", () => {
  const fact = {
    scope: { kind: "system", name: "payments" },
    kind: "decision",
    title: "Use PostgreSQL",
    content: "Use the shared PostgreSQL control store.",
    confidence: "high",
    provenance: [provenance],
    confirmedBy: "alice",
    confirmedAt: "2026-09-12T10:00:00.000Z",
  };
  const input = { schemaVersion: 1, operationKey: "op_propose", facts: Array.from({ length: 20 }, () => fact) };
  expect(MemoryProposalRequestSchema.safeParse(input).success).toBe(true);
  expect(MemoryProposalRequestSchema.safeParse({ ...input, facts: [...input.facts, fact] }).success).toBe(false);
  expect(
    MemoryProposalRequestSchema.safeParse({
      ...input,
      facts: [{ ...fact, scope: { kind: "domain", name: "payments" } }],
    }).success,
  ).toBe(false);
  expect(MemoryProposalRequestSchema.safeParse({ ...input, facts: [{ ...fact, wake: true }] }).success).toBe(false);
});

test("publications cap chunks at 256 and validate wake metadata", () => {
  const input = {
    schemaVersion: 1,
    operationKey: "op_publish",
    revision: gitSha,
    repository: "company/wagglebot-config",
    path: "company/knowledge/api.md",
    scope: { kind: "domain", name: "payments" },
    owner: "team-payments",
    chunks: Array.from({ length: 256 }, (_, index) => publicationChunk(index)),
  };
  expect(PublicationRequestSchema.safeParse(input).success).toBe(true);
  expect(
    PublicationRequestSchema.safeParse({ ...input, chunks: [...input.chunks, publicationChunk(256)] }).success,
  ).toBe(false);
  expect(
    PublicationRequestSchema.safeParse({ ...input, chunks: [{ ...publicationChunk(0), wake: true }] }).success,
  ).toBe(false);
  expect(
    PublicationRequestSchema.safeParse({
      ...input,
      chunks: [{ ...publicationChunk(0), wake: true, reviewAfter: "2027-03-01" }],
    }).success,
  ).toBe(true);
});

test("memory writes are final after synchronous embedding", () => {
  expect(
    WriteResultSchema.safeParse({
      schemaVersion: 1,
      operationKey: "op_123",
      outcomes: [{ recordId: uuid, outcome: "created" }],
    }).success,
  ).toBe(true);
  expect(
    WriteResultSchema.safeParse({
      schemaVersion: 1,
      operationKey: "op_123",
      outcomes: [{ recordId: uuid, outcome: "created", indexState: "pending" }],
    }).success,
  ).toBe(false);
  expect(MemoryErrorCodeSchema.safeParse("operation_key_conflict").success).toBe(true);
  expect(MemoryErrorCodeSchema.safeParse("internal_stack").success).toBe(false);
  expect(WriteResultSchema.safeParse({ operationKey: "op_123", outcomes: [] }).success).toBe(false);
});

test("memory searches return one cosine score without provider state", () => {
  expect(
    MemorySearchResultSchema.safeParse({
      schemaVersion: 1,
      records: [
        {
          record: record(),
          score: 0.87,
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    MemorySearchResultSchema.safeParse({
      schemaVersion: 1,
      records: [{ record: record(), fusedRank: 0.032_786_885, channelRanks: { lexical: 1, semantic: 2 } }],
      provider: { lexical: "ready", semantic: "ready" },
      degraded: false,
    }).success,
  ).toBe(false);
});

test("memory records exclude asynchronous indexing statuses", () => {
  expect(MemoryRecordSchema.safeParse(record({ status: "active" })).success).toBe(true);
  expect(MemoryRecordSchema.safeParse(record({ status: "pending_index" })).success).toBe(false);
});

test("memory MCP inputs omit only the HTTP schema version and retain route identifiers", () => {
  const expectedSchemas = [
    "MemorySearchMcpInputSchema",
    "MemoryQueryMcpInputSchema",
    "MemoryProposalMcpInputSchema",
    "RememberMcpInputSchema",
    "ForgetMcpInputSchema",
    "GetMemoryResponseSchema",
  ];
  expect(expectedSchemas.every((name) => name in memory)).toBe(true);

  const {
    ForgetMcpInputSchema,
    MemoryProposalMcpInputSchema,
    MemoryQueryMcpInputSchema,
    MemorySearchMcpInputSchema,
    RememberMcpInputSchema,
  } = memory as unknown as {
    ForgetMcpInputSchema: { safeParse(value: unknown): { success: boolean } };
    MemoryProposalMcpInputSchema: { safeParse(value: unknown): { success: boolean } };
    MemoryQueryMcpInputSchema: { safeParse(value: unknown): { success: boolean } };
    MemorySearchMcpInputSchema: { safeParse(value: unknown): { success: boolean } };
    RememberMcpInputSchema: { safeParse(value: unknown): { success: boolean } };
  };
  const query = {
    purpose: "query" as const,
    query: "how does token rotation work",
    cascade: { system: "payments", includeOrg: true },
  };
  const proposal = {
    operationKey: "op_propose",
    facts: [
      {
        scope: { kind: "system" as const, name: "payments" },
        kind: "decision" as const,
        title: "Use PostgreSQL",
        content: "Use the shared PostgreSQL control store.",
        confidence: "high" as const,
        provenance: [provenance],
        confirmedBy: "alice",
        confirmedAt: "2026-09-12T10:00:00.000Z",
      },
    ],
  };
  const remember = {
    operationKey: "op_remember",
    scope: { kind: "system" as const, name: "payments" },
    kind: "decision" as const,
    title: "Use PostgreSQL",
    content: "Use the shared PostgreSQL control store.",
    confidence: "high" as const,
    provenance: [provenance],
  };

  expect(MemorySearchMcpInputSchema.safeParse(query).success).toBe(true);
  expect(MemorySearchMcpInputSchema.safeParse({ ...query, schemaVersion: 1 }).success).toBe(false);
  expect(MemoryQueryMcpInputSchema.safeParse({ id: uuid }).success).toBe(true);
  expect(MemoryQueryMcpInputSchema.safeParse({ id: uuid, extra: true }).success).toBe(false);
  expect(MemoryProposalMcpInputSchema.safeParse(proposal).success).toBe(true);
  expect(RememberMcpInputSchema.safeParse(remember).success).toBe(true);
  expect(ForgetMcpInputSchema.safeParse({ id: uuid, operationKey: "op_forget", reason: "superseded" }).success).toBe(
    true,
  );
});

test("memory query returns one strict canonical record", () => {
  expect("GetMemoryResponseSchema" in memory).toBe(true);
  const { GetMemoryResponseSchema } = memory as unknown as {
    GetMemoryResponseSchema: { safeParse(value: unknown): { success: boolean } };
  };
  expect(GetMemoryResponseSchema.safeParse({ schemaVersion: 1, record: record() }).success).toBe(true);
  expect(GetMemoryResponseSchema.safeParse({ schemaVersion: 1, record: record(), extra: true }).success).toBe(false);
});

test("principals carry catalog-derived membership and verified token bounds", () => {
  expect(
    PrincipalSchema.safeParse({
      kind: "user",
      username: "alice",
      groups: ["team-payments"],
      orgOwner: false,
      issuedAt: "2026-09-12T10:00:00.000Z",
      expiresAt: "2026-09-12T10:15:00.000Z",
      tokenId: "jti_123",
    }).success,
  ).toBe(true);
  expect(PrincipalSchema.safeParse({ kind: "administrator", username: "memory-publisher" }).success).toBe(true);
  expect(PrincipalSchema.safeParse({ kind: "user", username: "Alice", groups: [], orgOwner: false }).success).toBe(
    false,
  );
});
