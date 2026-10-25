import type { ContextItem, ContextMarkdownMetadata, ContextPacket } from "@wagglebot/contracts";

export type RenderedContext = {
  text: string;
  structuredContent: Record<string, unknown>;
  estimatedTokens: number;
  bytes: number;
};
const codePoints = (value: string): number => Array.from(value).length;
const estimate = (value: unknown): number => Math.ceil(codePoints(JSON.stringify(value)) / 3);

const itemMarkdown = (item: ContextItem): string => {
  const evidence = item.provenance
    .map((ref) => {
      if (ref.kind === "code") return `${ref.path}:${ref.startLine}-${ref.endLine}`;
      if (ref.kind === "local_memory") return `${ref.path}:${ref.startLine}-${ref.endLine}`;
      if (ref.kind === "git") return `${ref.path ?? "commit"}@${ref.commit}`;
      return ref.path ? `${ref.repository ?? "shared"}/${ref.path}` : `shared memory ${ref.memoryId}`;
    })
    .join(", ");
  return `### ${item.title}\n${item.excerpt}\n\nEvidence: ${evidence}`;
};

export const compactMetadata = (packet: ContextPacket): ContextMarkdownMetadata => ({
  schemaVersion: 1,
  packetId: packet.packetId,
  cursor: packet.cursor,
  estimatedTokens: packet.estimatedTokens,
  ...(packet.omitted.candidates
    ? { omitted: { candidates: packet.omitted.candidates, estimatedTokens: packet.omitted.estimatedTokens } }
    : {}),
  ...(packet.degraded.length ? { degraded: packet.degraded.map(({ provider, code }) => ({ provider, code })) } : {}),
  ...(packet.conflicts.length
    ? { conflicts: packet.conflicts.map(({ itemIds, resolution }) => ({ itemIds, resolution })) }
    : {}),
});

export const renderContext = (packet: ContextPacket, format: "markdown" | "structured"): RenderedContext => {
  const prose = packet.items.map(itemMarkdown).join("\n\n");
  const status = packet.degraded.length
    ? `\n\nDegraded providers: ${packet.degraded.map(({ provider, code }) => `${provider}:${code}`).join(", ")}.`
    : "";
  const conflicts = packet.conflicts.length
    ? `\n\nConflicts: ${packet.conflicts.map(({ identityKey }) => identityKey).join(", ")}.`
    : "";
  const identity =
    [
      packet.project.component,
      packet.project.system,
      packet.project.branch,
      packet.project.head?.slice(0, 12),
      packet.project.workingTree,
    ]
      .filter(Boolean)
      .join(" · ") || "Repository context";
  const markdown = `## ${identity}\n${prose || "No new retrieved context."}${conflicts}${status}`;
  const baseStructured = format === "markdown" ? compactMetadata(packet) : packet;
  const text =
    format === "markdown"
      ? markdown
      : `${packet.mode} context: ${packet.items.length} items; ${packet.degraded.length} degraded providers.`;
  const structuredContent = { ...(baseStructured as object), estimatedTokens: packet.estimatedTokens } as Record<
    string,
    unknown
  >;
  const serialized = JSON.stringify({ content: [{ type: "text", text }], structuredContent });
  return {
    text,
    structuredContent,
    estimatedTokens: estimate({ text, structuredContent }),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
};

export const clipExcerpt = (text: string, maxCodePoints: number): { text: string; clipped: boolean } => {
  const marker = "[content clipped]";
  const markerSize = codePoints(marker);
  if (codePoints(text) <= maxCodePoints) return { text, clipped: false };
  if (maxCodePoints < markerSize) return { text: "", clipped: true };
  const available = maxCodePoints - markerSize - 2;
  const paragraphs = text.split(/\n\s*\n/u);
  let output = "";
  for (const paragraph of paragraphs) {
    const next = output ? `${output}\n\n${paragraph}` : paragraph;
    if (codePoints(next) > available) break;
    output = next;
  }
  return { text: output ? `${output}\n\n${marker}` : marker, clipped: true };
};
