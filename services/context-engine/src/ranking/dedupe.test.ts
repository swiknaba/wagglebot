import { expect, test } from "bun:test";
import type { RankedCandidate } from "../retrieval/types";
import { dedupeCandidates } from "./dedupe";

const item = (id: string, hash: string): RankedCandidate => ({
  id,
  source: "local_memory",
  kind: "concept",
  title: id,
  content: "same content",
  contentHash: hash,
  exactMatch: false,
  provenance: [{ kind: "local_memory", path: ".agents/memory/x.md", startLine: 1, endLine: 1, contentHash: hash }],
  freshness: "live",
  authorityTier: 60,
  channels: [],
  fusedScore: 1,
});

test("deduplicates only identical explicit locators and hashes", () => {
  const result = dedupeCandidates([item("one", "a"), item("two", "a"), item("three", "b")]);
  expect(result.items.map(({ id }) => id)).toEqual(["one", "three"]);
  expect(result.duplicates).toBe(1);
  expect(result.items[0]?.provenance).toHaveLength(1);
});
