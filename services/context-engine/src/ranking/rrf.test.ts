import { expect, test } from "bun:test";
import type { RetrievalCandidate } from "../retrieval/types";
import { rankCandidates } from "./rrf";

const candidate = (id: string, channel: string, rank: number, weight: number): RetrievalCandidate => ({
  id,
  source: channel === "code_exact" ? "code" : "git",
  kind: "symbol",
  title: id,
  content: id,
  contentHash: id,
  exactMatch: false,
  provenance: [{ kind: "git", commit: "a".repeat(40) }],
  freshness: "live",
  authorityTier: 70,
  channels: [{ name: channel, rank, weight }],
});

test("weighted reciprocal rank fusion adds channel ranks without mixing source scores", () => {
  const ranked = rankCandidates([
    candidate("strong", "code_exact", 1, 1.4),
    candidate("weak", "git_history", 1, 1.1),
    candidate("shared", "git_history", 3, 1.1),
  ]);
  expect(ranked.map((item) => item.id)).toEqual(["strong", "weak", "shared"]);
  expect(ranked[0]?.fusedScore).toBeCloseTo(1.4 / 61);
});

test("same provider identity merges channels and evidence", () => {
  const ranked = rankCandidates([
    candidate("same", "code_exact", 1, 1.4),
    { ...candidate("same", "git_history", 2, 1.1), provenance: [{ kind: "git", commit: "b".repeat(40) }] },
  ]);
  expect(ranked).toHaveLength(1);
  expect(ranked[0]?.channels).toHaveLength(2);
  expect(ranked[0]?.provenance).toHaveLength(2);
});
