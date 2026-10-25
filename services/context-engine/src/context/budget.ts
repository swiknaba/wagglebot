import type { ContextItem, ContextPacket } from "@wagglebot/contracts";
import { renderContext } from "./representation";

export class ContextBudgetError extends Error {
  constructor() {
    super("context_invalid");
  }
}

export const fitContextPacket = (
  packet: ContextPacket,
  format: "markdown" | "structured",
  budget: number,
  mandatoryItemIds: ReadonlySet<string> = new Set(),
): ContextPacket => {
  const items = [...packet.items];
  const dropped: ContextItem[] = [];
  while (true) {
    const candidate: ContextPacket = {
      ...packet,
      items,
      omitted:
        dropped.length === 0
          ? packet.omitted
          : {
              candidates: packet.omitted.candidates + dropped.length,
              estimatedTokens:
                packet.omitted.estimatedTokens +
                Math.ceil(dropped.reduce((sum, item) => sum + Array.from(item.excerpt).length, 0) / 3),
              reasons: [...new Set([...packet.omitted.reasons, "budget" as const])],
            },
      estimatedTokens: 0,
    };
    const initial = renderContext(candidate, format);
    const finalized = { ...candidate, estimatedTokens: initial.estimatedTokens };
    const rendered = renderContext(finalized, format);
    if (rendered.estimatedTokens <= budget && rendered.bytes <= 16 * 1024)
      return { ...finalized, estimatedTokens: rendered.estimatedTokens };
    const removableIndex = [...items]
      .map((item, index) => ({ item, index }))
      .reverse()
      .find(({ item }) => !mandatoryItemIds.has(item.id))?.index;
    if (removableIndex === undefined) throw new ContextBudgetError();
    const removable = items[removableIndex];
    if (!removable) throw new ContextBudgetError();
    dropped.push(removable);
    items.splice(removableIndex, 1);
  }
};
