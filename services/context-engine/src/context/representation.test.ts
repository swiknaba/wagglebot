import { expect, test } from "bun:test";
import { ContextPacketSchema } from "@wagglebot/contracts";
import { fitContextPacket } from "./budget";
import { renderContext } from "./representation";

const packet = ContextPacketSchema.parse({
  schemaVersion: 1,
  packetId: "pkt_0123456789abcdef",
  cursor: "ctx_0123456789abcdefghijklmn",
  mode: "search",
  request: { query: "auth", effectiveMaxTokens: 800 },
  project: { workingTree: "clean", catalogState: "resolved" },
  freshness: { generatedAt: "2026-10-25T10:00:00.000Z", codeGraph: "ready", pendingFiles: [] },
  items: [
    {
      id: "memory:a",
      source: "local_memory",
      scope: "component",
      kind: "warning",
      title: "Rotate tokens",
      excerpt: "Rotate the token after each deployment.",
      provenance: [
        {
          kind: "local_memory",
          path: ".agents/memory/warnings/rotate.md",
          startLine: 1,
          endLine: 2,
          contentHash: "a".repeat(64),
        },
      ],
      freshness: "live",
      channelRanks: { local_memory_bm25: 1 },
      fusedScore: 1,
      authorityTier: 60,
    },
  ],
  conflicts: [],
  degraded: [],
  omitted: { candidates: 0, estimatedTokens: 0, reasons: [] },
  estimatedTokens: 0,
});

test("markdown puts item prose in one representation and structured mode keeps packet shape", () => {
  const markdown = renderContext(packet, "markdown");
  expect(markdown.text).toContain("Rotate the token");
  expect(JSON.stringify(markdown.structuredContent)).not.toContain("Rotate the token");
  const structured = renderContext(packet, "structured");
  expect(structured.text).not.toContain("Rotate the token");
  expect(JSON.stringify(structured.structuredContent)).toContain("Rotate the token");
});

test("budget removes optional ranked items but rejects an infeasible mandatory response", () => {
  const firstItem = packet.items[0];
  if (!firstItem) throw new Error("expected a packet item");
  const many = {
    ...packet,
    items: Array.from({ length: 6 }, (_, index) => ({
      ...firstItem,
      id: `item:${index}`,
      excerpt: "long content ".repeat(40),
    })),
  };
  const fitted = fitContextPacket(many, "markdown", 100);
  expect(fitted.items.length).toBeLessThan(6);
  expect(() => fitContextPacket(many, "markdown", 1, new Set(many.items.map(({ id }) => id)))).toThrow(
    "context_invalid",
  );
});
