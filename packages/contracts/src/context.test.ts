import { expect, test } from "bun:test";
import {
  BrainExplainInputSchema,
  BrainSearchInputSchema,
  BrainStatusResultSchema,
  BrainWakeInputSchema,
  ContextCursorSchema,
  ContextItemSchema,
  ContextMarkdownMetadataSchema,
  ContextPacketSchema,
} from "./index";

const timestamp = "2026-09-12T12:00:00.000Z";
const packetId = "pkt_0123456789abcdef";
const cursor = "ctx_0123456789abcdefghijklmn";
const sha = "a".repeat(40);
const item = {
  id: "code:TokenService.rotate",
  source: "code",
  kind: "symbol",
  title: "TokenService.rotate",
  excerpt: "Rotates the token.",
  provenance: [{ kind: "code", path: "src/token.ts", startLine: 1, endLine: 2, graphState: "ready" }],
  freshness: "live",
  channelRanks: { code_exact: 1 },
  fusedScore: 0.02,
  authorityTier: 100,
};

const packet = {
  schemaVersion: 1,
  packetId,
  cursor,
  mode: "search",
  request: { query: "token rotation", requestedMaxTokens: 800, effectiveMaxTokens: 800 },
  project: { workingTree: "clean", catalogState: "resolved" },
  freshness: { generatedAt: timestamp, codeGraph: "ready", pendingFiles: [] },
  items: [item],
  conflicts: [],
  degraded: [],
  omitted: { candidates: 0, estimatedTokens: 0, reasons: [] },
  estimatedTokens: 100,
};

test("context items require evidence and freshness and reject unknown fields", () => {
  expect(ContextItemSchema.safeParse({ ...item, provenance: [] }).success).toBe(false);
  expect(ContextItemSchema.safeParse({ ...item, freshness: undefined }).success).toBe(false);
  expect(ContextItemSchema.safeParse({ ...item, markdown: "duplicate" }).success).toBe(false);
  expect(ContextItemSchema.safeParse({ ...item, fusedScore: Number.NaN }).success).toBe(false);
});

test("inputs require absolute project paths, strict fields, and bounded Unicode text/budgets", () => {
  expect(BrainWakeInputSchema.safeParse({ projectPath: "../repo", level: 1 }).success).toBe(false);
  expect(BrainWakeInputSchema.safeParse({ projectPath: "/repo", extra: true }).success).toBe(false);
  expect(BrainSearchInputSchema.safeParse({ projectPath: "/repo", query: "x", maxTokens: 1_501 }).success).toBe(false);
  expect(BrainSearchInputSchema.safeParse({ projectPath: "/repo", query: "😀".repeat(2_001) }).success).toBe(false);
  expect(
    BrainWakeInputSchema.safeParse({ projectPath: "/repo", level: 3, task: "plan the migration", maxTokens: 5_000 })
      .success,
  ).toBe(true);
  expect(BrainWakeInputSchema.safeParse({ projectPath: "/repo", level: 2 }).success).toBe(false);
  expect(BrainWakeInputSchema.safeParse({ projectPath: "/repo", level: 1, maxTokens: 501 }).success).toBe(false);
  expect(
    BrainSearchInputSchema.safeParse({ projectPath: "/repo", query: "x", remainingContextTokens: 0 }).success,
  ).toBe(false);
});

test("search controls accept a bounded opaque cursor and remaining-context hint", () => {
  expect(
    BrainSearchInputSchema.safeParse({
      projectPath: "/repo",
      query: "token rotation",
      cursor,
      remainingContextTokens: 20_000,
      responseFormat: "markdown",
    }).success,
  ).toBe(true);
  expect(ContextCursorSchema.safeParse("x").success).toBe(true);
  expect(ContextCursorSchema.safeParse("x".repeat(129)).success).toBe(false);
  expect(ContextCursorSchema.safeParse("bad.cursor").success).toBe(false);
});

test("explain requires paired ordered lines and repository-relative paths", () => {
  expect(BrainExplainInputSchema.safeParse({ projectPath: "/repo", path: "src/token.ts", startLine: 2 }).success).toBe(
    false,
  );
  expect(
    BrainExplainInputSchema.safeParse({ projectPath: "/repo", path: "src/token.ts", startLine: 3, endLine: 2 }).success,
  ).toBe(false);
  expect(BrainExplainInputSchema.safeParse({ projectPath: "/repo", path: "../token.ts" }).success).toBe(false);
  expect(
    BrainExplainInputSchema.safeParse({ projectPath: "/repo", path: "src/token.ts", startLine: 2, endLine: 2 }).success,
  ).toBe(true);
});

test("context packet follows the strict v1 shape and uses the base packet ID contract", () => {
  expect(ContextPacketSchema.safeParse(packet).success).toBe(true);
  expect(ContextPacketSchema.safeParse({ ...packet, unexpected: true }).success).toBe(false);
  expect(ContextPacketSchema.safeParse({ ...packet, packetId: "has space" }).success).toBe(false);
  expect(
    ContextPacketSchema.safeParse({ ...packet, freshness: { ...packet.freshness, pendingFiles: ["/private/file.ts"] } })
      .success,
  ).toBe(false);
  expect(
    ContextPacketSchema.safeParse({ ...packet, omitted: { candidates: 0, estimatedTokens: 0, reasons: ["unknown"] } })
      .success,
  ).toBe(false);
  expect(
    ContextPacketSchema.safeParse({
      ...packet,
      request: { ...packet.request, requestedMaxTokens: 1_501 },
    }).success,
  ).toBe(false);
  expect(
    ContextPacketSchema.safeParse({
      ...packet,
      request: { ...packet.request, remainingContextTokens: 100, effectiveMaxTokens: 6 },
    }).success,
  ).toBe(false);
  expect(
    ContextPacketSchema.safeParse({
      ...packet,
      mode: "wake",
      request: { requestedLevel: 0, effectiveMaxTokens: 100 },
      items: [],
    }).success,
  ).toBe(true);
  expect(
    ContextPacketSchema.safeParse({
      ...packet,
      mode: "wake",
      request: { requestedLevel: 0, effectiveMaxTokens: 100 },
    }).success,
  ).toBe(false);
});

test("status result fixes the cursor-cache limits and rejects retrieved prose", () => {
  const provider = { state: "ready", observedAt: timestamp };
  const status = {
    schemaVersion: 1,
    project: { workingTree: "clean", catalogState: "resolved" },
    providers: {
      local_memory: provider,
      code: provider,
      git: provider,
      shared_memory: { ...provider, state: "not_requested" },
    },
    freshness: { generatedAt: timestamp, gitHead: sha, workingTree: "clean" },
    cursorCache: { entries: 3, maxEntries: 128, ttlSeconds: 14_400 },
    lastRequestTiming: { totalMs: 12, providers: { code: 5 } },
  };
  expect(BrainStatusResultSchema.safeParse(status).success).toBe(true);
  expect(
    BrainStatusResultSchema.safeParse({ ...status, cursorCache: { ...status.cursorCache, maxEntries: 64 } }).success,
  ).toBe(false);
  expect(BrainStatusResultSchema.safeParse({ ...status, prose: "secret" }).success).toBe(false);
});

test("default Markdown metadata carries counts, stable failure codes, handles, and conflict IDs only", () => {
  const metadata = {
    schemaVersion: 1,
    packetId,
    cursor,
    estimatedTokens: 100,
    omitted: { candidates: 1, estimatedTokens: 20 },
    degraded: [{ provider: "code", code: "timeout" }],
    evidenceHandles: [{ itemId: item.id, handles: ["code://src/token.ts#L1"] }],
    conflicts: [{ itemIds: [item.id, "memory:one"], resolution: "unresolved" }],
  };
  expect(ContextMarkdownMetadataSchema.safeParse(metadata).success).toBe(true);
  expect(ContextMarkdownMetadataSchema.safeParse({ ...metadata, prose: "fact" }).success).toBe(false);
});
