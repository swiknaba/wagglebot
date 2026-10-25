import type { ContextConflict } from "@wagglebot/contracts";
import type { RankedCandidate } from "../retrieval/types";

export const findConflicts = (items: RankedCandidate[]): ContextConflict[] => {
  const groups = new Map<string, RankedCandidate[]>();
  for (const item of items) {
    if (!item.identityKey) continue;
    groups.set(item.identityKey, [...(groups.get(item.identityKey) ?? []), item]);
  }
  return [...groups].flatMap(([identityKey, group]) => {
    const distinct = [...new Map(group.map((item) => [item.contentHash, item])).values()];
    if (distinct.length < 2) return [];
    const preferred = [...distinct].sort(
      (a, b) => b.authorityTier - a.authorityTier || Number(b.exactMatch) - Number(a.exactMatch),
    )[0];
    return [
      {
        identityKey,
        itemIds: distinct.map((item) => item.id).sort(),
        resolution:
          preferred?.source === "code"
            ? ("current_source_preferred" as const)
            : preferred?.source === "local_memory"
              ? ("reviewed_source_preferred" as const)
              : ("unresolved" as const),
        reason: "Different values share an explicit identity.",
      },
    ];
  });
};
