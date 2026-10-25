import type { RankedCandidate } from "../retrieval/types";

export const dedupeCandidates = (items: RankedCandidate[]): { items: RankedCandidate[]; duplicates: number } => {
  const result = new Map<string, RankedCandidate>();
  for (const item of items) {
    const locator = item.provenance
      .map((ref) => JSON.stringify(ref))
      .sort()
      .join("|");
    const key = item.identityKey ? `${item.identityKey}:${item.contentHash}` : `${locator}:${item.contentHash}`;
    const existing = result.get(key);
    if (existing) {
      existing.provenance = [
        ...new Map([...existing.provenance, ...item.provenance].map((ref) => [JSON.stringify(ref), ref])).values(),
      ];
      existing.channels.push(...item.channels);
      continue;
    }
    result.set(key, { ...item, provenance: [...item.provenance], channels: [...item.channels] });
  }
  return { items: [...result.values()], duplicates: items.length - result.size };
};
