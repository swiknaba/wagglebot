import { expect, test } from "bun:test";
import type { RankedCandidate } from "../retrieval/types";
import { findConflicts } from "./conflicts";

const item = (id: string, hash: string, source: "code" | "local_memory"): RankedCandidate => ({
  id,
  source,
  kind: source === "code" ? "symbol" : "decision",
  title: "retry policy",
  content: hash,
  contentHash: hash,
  identityKey: "retry-policy",
  exactMatch: false,
  provenance:
    source === "code"
      ? [{ kind: "code", path: "src/retry.ts", startLine: 1, endLine: 2, graphState: "ready" }]
      : [
          {
            kind: "local_memory",
            path: ".agents/memory/decisions/retry.md",
            startLine: 1,
            endLine: 2,
            contentHash: "c".repeat(64),
          },
        ],
  freshness: "live",
  authorityTier: source === "code" ? 100 : 60,
  channels: [],
  fusedScore: 1,
});

test("conflict detection requires an explicit shared identity and different content", () => {
  const conflicts = findConflicts([item("source", "a", "code"), item("memory", "b", "local_memory")]);
  expect(conflicts).toEqual([
    {
      identityKey: "retry-policy",
      itemIds: ["memory", "source"],
      resolution: "current_source_preferred",
      reason: "Different values share an explicit identity.",
    },
  ]);
  expect(findConflicts([item("a", "same", "code"), item("b", "same", "local_memory")])).toEqual([]);
  expect(findConflicts([{ ...item("a", "a", "code"), identityKey: undefined }])).toEqual([]);
});
