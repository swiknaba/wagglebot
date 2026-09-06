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
    // A line that lacks a trailing newline always gets a blank line before the block, for every
    // style, so the block never runs onto the end of that line.
    // A line that already ends in a newline gets a blank line only for html blocks, for
    // readability in markdown and config files. Hash blocks sit directly under existing shell
    // lines, with no blank line.
    const sep = existing === "" ? "" : existing.endsWith("\n") ? (style === "html" ? "\n" : "") : "\n\n";
    return { next: `${existing}${sep}${rendered}\n`, changed: true };
  }
  if (begin === -1) throw new Error("managed block: found the end marker without a begin marker");
  if (end === -1) throw new Error("managed block: found the begin marker without an end marker");
  if (end < begin) throw new Error("managed block: the end marker appears before the begin marker");
  const next = existing.slice(0, begin) + rendered + existing.slice(end + END.length);
  return { next, changed: next !== existing };
}

// Removes the managed block and the blank line that separates it from the content before it.
// Content outside the block never changes. A file without a block is returned as it is.
export function removeManagedBlock(existing: string, style: MarkerStyle = "html"): { next: string; changed: boolean } {
  const { begin: BEGIN, end: END } = MARKERS[style];
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (begin === -1 && end === -1) return { next: existing, changed: false };
  if (begin === -1) throw new Error("managed block: found the end marker without a begin marker");
  if (end === -1) throw new Error("managed block: found the begin marker without an end marker");
  if (end < begin) throw new Error("managed block: the end marker appears before the begin marker");
  let head = existing.slice(0, begin);
  let tail = existing.slice(end + END.length);
  if (tail.startsWith("\n")) tail = tail.slice(1);
  if (head.endsWith("\n\n")) head = head.slice(0, -1);
  // A block at the top of the file also takes the blank line under it, so the rest starts at line one.
  if (head === "") tail = tail.replace(/^\n+/, "");
  const next = head + tail;
  return { next, changed: next !== existing };
}
