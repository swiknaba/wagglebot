import { createHash } from "node:crypto";

import type { LocalMemoryChunk, LocalMemorySection } from "../types";

const MAX_MEMORY_BYTES = 256 * 1024;
const MAX_CHUNK_CODE_POINTS = 4_000;
const SECTIONS = new Set<LocalMemorySection>([
  "Architecture",
  "Conventions",
  "Commands",
  "Decisions",
  "Warnings",
  "Learnings",
]);

type Heading = {
  level: number;
  title: string;
  lineIndex: number;
};

export type LocalMemoryDocument = {
  path: ".agents/memory.md";
  text: string;
  contentHash: string;
  chunks: LocalMemoryChunk[];
};

export class MemoryParseError extends Error {}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const codePointLength = (value: string): number => [...value].length;

const isFence = (line: string): boolean => /^\s*(```|~~~)/u.test(line);

const headingsOf = (lines: string[]): Heading[] => {
  const headings: Heading[] = [];
  let fenced = false;

  for (const [lineIndex, line] of lines.entries()) {
    if (isFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    headings.push({ level: match[1].length, title: match[2].trim(), lineIndex });
  }
  return headings;
};

const trimmedBody = (lines: string[]): { content: string; leadingLines: number; trailingLines: number } => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return { content: lines.slice(start, end).join("\n"), leadingLines: start, trailingLines: lines.length - end };
};

const splitChunk = (content: string): Array<{ content: string; offset: number }> => {
  if (codePointLength(content) <= MAX_CHUNK_CODE_POINTS) return [{ content, offset: 0 }];

  const chunks: Array<{ content: string; offset: number }> = [];
  let remaining = content;
  let consumed = 0;
  while (codePointLength(remaining) > MAX_CHUNK_CODE_POINTS) {
    const points = [...remaining];
    let boundary = points
      .slice(0, MAX_CHUNK_CODE_POINTS + 1)
      .join("")
      .lastIndexOf("\n\n");
    if (boundary <= 0) {
      const candidate = points.slice(0, MAX_CHUNK_CODE_POINTS + 1).join("");
      boundary = Math.max(candidate.lastIndexOf(". ") + 1, candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    }
    if (boundary <= 0) boundary = [...remaining].slice(0, MAX_CHUNK_CODE_POINTS).join("").length;

    const raw = remaining.slice(0, boundary);
    const piece = raw.trimEnd();
    if (piece !== "") chunks.push({ content: piece, offset: consumed });
    remaining = remaining.slice(boundary).replace(/^\s+/u, "");
    consumed = content.length - remaining.length;
  }
  if (remaining !== "") chunks.push({ content: remaining, offset: consumed });
  return chunks;
};

const lineAtOffset = (content: string, offset: number, startLine: number): number =>
  startLine + content.slice(0, offset).split("\n").length - 1;

export const parseMemory = (text: string, path: ".agents/memory.md"): LocalMemoryDocument => {
  if (Buffer.byteLength(text, "utf8") > MAX_MEMORY_BYTES) throw new MemoryParseError("local memory exceeds 256 KiB");
  if (text.includes("\0") || text.includes("\uFFFD")) throw new MemoryParseError("invalid memory text");

  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const headings = headingsOf(lines);
  if (!headings.some((heading) => heading.level === 1)) throw new MemoryParseError("memory requires an H1 heading");

  for (const heading of headings) {
    if (heading.level === 2 && !SECTIONS.has(heading.title as LocalMemorySection)) {
      throw new MemoryParseError("unknown memory section");
    }
  }

  const chunks: LocalMemoryChunk[] = [];
  let ordinal = 0;
  for (const [headingIndex, heading] of headings.entries()) {
    if (heading.level !== 2 && heading.level !== 3) continue;
    const parent =
      heading.level === 3
        ? [...headings.slice(0, headingIndex)].reverse().find((candidate) => candidate.level === 2)
        : undefined;
    if (heading.level === 3 && parent === undefined)
      throw new MemoryParseError("H3 memory entry requires an H2 section");

    const nextHeading = headings
      .slice(headingIndex + 1)
      .find((candidate) =>
        heading.level === 2 ? candidate.level <= 2 || candidate.level === 3 : candidate.level <= 3,
      );
    const rawStart = heading.lineIndex + 1;
    const rawEnd = nextHeading?.lineIndex ?? lines.length;
    const body = trimmedBody(lines.slice(rawStart, rawEnd));
    if (body.content === "") continue;

    const headingPath = parent === undefined ? [heading.title] : [parent.title, heading.title];
    const firstLine = rawStart + body.leadingLines + 1;
    for (const piece of splitChunk(body.content)) {
      const startLine = lineAtOffset(body.content, piece.offset, firstLine);
      const endLine = startLine + piece.content.split("\n").length - 1;
      chunks.push({
        id: sha256([path, headingPath.join(" / "), String(ordinal)].join("\0")),
        headingPath,
        content: piece.content,
        startLine,
        endLine,
        contentHash: sha256(piece.content),
      });
      ordinal += 1;
    }
  }

  if (chunks.length === 0) throw new MemoryParseError("memory has no section content");
  return { path, text: text.replace(/\r\n?/gu, "\n"), contentHash: sha256(text.replace(/\r\n?/gu, "\n")), chunks };
};
