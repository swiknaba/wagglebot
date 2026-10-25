import { expect, test } from "bun:test";
import { ContextBridgeExportInputSchema, ContextBridgePacketSchema } from "./index";

const base = {
  schemaVersion: 1 as const,
  packetId: "cb_pkt_0123456789abcdefghijklmn",
  project: { rootKey: `rk_${"a".repeat(32)}` },
  scope: "project" as const,
  goal: "Ship the context engine",
  decisions: [{ title: "Use local cache", summary: "Keep packet context ephemeral." }],
  openQuestions: ["Which provider owns freshness?"],
  evidence: [{ kind: "code" as const, path: "src/engine.ts", startLine: 1, endLine: 4, graphState: "ready" as const }],
  providerState: { localBrain: "ready" as const, sharedMemory: "not_requested" as const },
  createdAt: "2026-10-25T10:00:00.000Z",
  expiresAt: "2026-10-25T11:00:00.000Z",
};

test("accepts a bounded packet and rejects unknown transcript-shaped fields", () => {
  expect(ContextBridgePacketSchema.safeParse(base).success).toBe(true);
  expect(ContextBridgePacketSchema.safeParse({ ...base, transcript: "private" }).success).toBe(false);
  expect(ContextBridgePacketSchema.safeParse({ ...base, expiresAt: base.createdAt }).success).toBe(false);
  expect(ContextBridgePacketSchema.safeParse({ ...base, goal: "x".repeat(301) }).success).toBe(false);
  expect(
    ContextBridgePacketSchema.safeParse({
      ...base,
      evidence: [{ kind: "code", path: "/private/a.ts", startLine: 1, endLine: 1, graphState: "ready" }],
    }).success,
  ).toBe(false);
});

test("export accepts explicit scope and rejects excess lifetime, fields, and content counts", () => {
  const input = {
    projectPath: "/repo",
    goal: "Continue",
    decisions: [],
    openQuestions: [],
    evidence: [],
    providerState: base.providerState,
  };
  expect(ContextBridgeExportInputSchema.safeParse(input).success).toBe(true);
  expect(ContextBridgeExportInputSchema.safeParse({ ...input, scope: "workstation", ttlSeconds: 14_400 }).success).toBe(
    true,
  );
  expect(ContextBridgeExportInputSchema.safeParse({ ...input, ttlSeconds: 14_401 }).success).toBe(false);
  expect(
    ContextBridgeExportInputSchema.safeParse({
      ...input,
      decisions: Array.from({ length: 11 }, () => ({ title: "t", summary: "s" })),
    }).success,
  ).toBe(false);
  expect(ContextBridgeExportInputSchema.safeParse({ ...input, transcript: "not allowed" }).success).toBe(false);
});
