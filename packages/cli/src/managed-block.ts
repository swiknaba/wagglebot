export type MarkerStyle = "html" | "hash";
const MARKERS: Record<MarkerStyle, { begin: string; end: string }> = {
  html: { begin: "<!-- wagglebot:begin -->", end: "<!-- wagglebot:end -->" },
  hash: { begin: "# wagglebot:begin", end: "# wagglebot:end" },
};
export const BLOCK_BEGIN = MARKERS.html.begin;
export const BLOCK_END = MARKERS.html.end;

export function renderManagedBlock(
  existing: string,
  content: string,
  style: MarkerStyle = "html",
): { next: string; changed: boolean } {
  const { begin: BEGIN, end: END } = MARKERS[style];
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  const rendered = `${BEGIN}\n${content}\n${END}`;
  if (begin === -1 && end === -1) {
    // html blocks get a blank line before them, for readability in markdown and config files.
    // hash blocks sit directly under existing shell lines, with no blank line.
    const sep = existing === "" ? "" : existing.endsWith("\n") ? (style === "html" ? "\n" : "") : "\n";
    return { next: `${existing}${sep}${rendered}\n`, changed: true };
  }
  if (begin === -1) throw new Error("managed block: found the end marker without a begin marker");
  if (end === -1) throw new Error("managed block: found the begin marker without an end marker");
  if (end < begin) throw new Error("managed block: the end marker appears before the begin marker");
  const next = existing.slice(0, begin) + rendered + existing.slice(end + END.length);
  return { next, changed: next !== existing };
}
