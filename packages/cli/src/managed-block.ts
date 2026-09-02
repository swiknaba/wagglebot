export const BLOCK_BEGIN = "<!-- wagglebot:begin -->";
export const BLOCK_END = "<!-- wagglebot:end -->";

export function renderManagedBlock(existing: string, content: string): { next: string; changed: boolean } {
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  const rendered = `${BLOCK_BEGIN}\n${content}\n${BLOCK_END}`;
  if (begin === -1 && end === -1) {
    const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { next: `${existing}${sep}${rendered}\n`, changed: true };
  }
  if (begin === -1) throw new Error("managed block: found the end marker without a begin marker");
  if (end === -1) throw new Error("managed block: found the begin marker without an end marker");
  if (end < begin) throw new Error("managed block: the end marker appears before the begin marker");
  const next = existing.slice(0, begin) + rendered + existing.slice(end + BLOCK_END.length);
  return { next, changed: next !== existing };
}
