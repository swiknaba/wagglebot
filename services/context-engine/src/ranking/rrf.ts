import type { RankedCandidate, RetrievalCandidate } from "../retrieval/types";

const scopeRank = (scope: RankedCandidate["scope"]): number =>
  scope === "component" ? 4 : scope === "system" ? 3 : scope === "domain" ? 2 : scope === "org" ? 1 : 0;

const authority = (a: RankedCandidate, b: RankedCandidate): number =>
  b.authorityTier - a.authorityTier ||
  scopeRank(b.scope) - scopeRank(a.scope) ||
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
  a.id.localeCompare(b.id);

export const rankCandidates = (candidates: RetrievalCandidate[]): RankedCandidate[] => {
  const byId = new Map<string, RankedCandidate>();
  for (const candidate of candidates) {
    const score = candidate.channels.reduce((sum, channel) => sum + channel.weight / (60 + channel.rank), 0);
    const previous = byId.get(candidate.id);
    if (previous === undefined) {
      byId.set(candidate.id, { ...candidate, fusedScore: score });
      continue;
    }
    previous.fusedScore += score;
    previous.channels.push(...candidate.channels);
    previous.exactMatch ||= candidate.exactMatch;
    previous.provenance = [
      ...new Map([...previous.provenance, ...candidate.provenance].map((ref) => [JSON.stringify(ref), ref])).values(),
    ];
  }
  return [...byId.values()].sort(
    (a, b) => b.fusedScore - a.fusedScore || Number(b.exactMatch) - Number(a.exactMatch) || authority(a, b),
  );
};
