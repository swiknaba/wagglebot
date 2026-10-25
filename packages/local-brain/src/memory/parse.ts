import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

import type { LocalMemoryChunk, LocalMemoryConcept, LocalMemoryPath } from "../types";

const MAX_CHUNK_CODE_POINTS = 4_000;
const MEMORY_PATH_PREFIX = ".agents/memory/";

type Heading = {
  level: number;
  title: string;
  lineIndex: number;
};

export class MemoryParseError extends Error {
  constructor(
    readonly path: LocalMemoryPath,
    message: string,
  ) {
    super(`${path.slice(MEMORY_PATH_PREFIX.length)}: ${message}`);
    this.name = "MemoryParseError";
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const codePointLength = (value: string): number => [...value].length;

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

type Fence = { marker: "`" | "~"; length: number };

const fenceLine = (line: string): { marker: "`" | "~"; length: number; rest: string } | undefined => {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { marker: match[1][0] as "`" | "~", length: match[1].length, rest: match[2] };
};

const headingOnLine = (line: string): Heading | undefined => {
  const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/u.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { level: match[1].length, title: match[2].trim(), lineIndex: -1 };
};

const pathTitle = (path: LocalMemoryPath): string => {
  const filename = path.slice(MEMORY_PATH_PREFIX.length).split("/").at(-1) ?? "";
  return filename.slice(0, -3).replace(/-/gu, " ");
};

export const parseConcept = (text: string, path: LocalMemoryPath): LocalMemoryConcept => {
  const normalizedText = text.replace(/\r\n?/gu, "\n");
  const relativePath = path.slice(MEMORY_PATH_PREFIX.length);
  const fail = (reason: string): never => {
    throw new MemoryParseError(path, reason);
  };

  if (normalizedText.includes("\0") || normalizedText.includes("\uFFFD")) fail("invalid text");

  const lines = normalizedText.split("\n");
  if (lines[0] !== "---") fail("invalid frontmatter");
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) fail("invalid frontmatter");

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(lines.slice(1, closingIndex).join("\n"));
  } catch {
    throw new MemoryParseError(path, "invalid frontmatter");
  }
  if (document.errors.length > 0) fail("invalid frontmatter");

  let parsed: unknown;
  try {
    parsed = document.toJS();
  } catch {
    fail("invalid frontmatter");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid frontmatter");

  const frontmatter = parsed as Record<string, unknown>;
  const rawType = frontmatter.type;
  const type = typeof rawType === "string" ? rawType.trim() : "";
  if (type === "") fail("missing or invalid type");

  const rawTitle = frontmatter.title;
  const title = typeof rawTitle === "string" && rawTitle.trim() !== "" ? rawTitle.trim() : pathTitle(path);
  const rawDescription = frontmatter.description;
  const description = typeof rawDescription === "string" ? rawDescription : undefined;
  const rawTags = frontmatter.tags;
  const tags = Array.isArray(rawTags) && rawTags.every((tag): tag is string => typeof tag === "string") ? rawTags : [];

  const bodyLines = lines.slice(closingIndex + 1);
  const body = bodyLines.join("\n");
  const bodyStartLine = closingIndex + 2;
  const chunks: LocalMemoryChunk[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let latestHeadingPath: string[] = [];
  let segmentStart = 0;
  let fence: Fence | undefined;
  let ordinal = 0;

  const addRegion = (regionLines: string[], startIndex: number, headingPath: string[]): void => {
    let start = 0;
    let end = regionLines.length;
    while (start < end && regionLines[start]?.trim() === "") start += 1;
    while (end > start && regionLines[end - 1]?.trim() === "") end -= 1;
    if (start === end) return;

    const content = regionLines.slice(start, end).join("\n");
    const firstLine = bodyStartLine + startIndex + start;
    for (const piece of splitChunk(content)) {
      const startLine = lineAtOffset(content, piece.offset, firstLine);
      const endLine = startLine + piece.content.split("\n").length - 1;
      chunks.push({
        id: sha256([path, headingPath.join(" / "), String(ordinal)].join("\0")),
        path,
        type,
        title,
        ...(description === undefined ? {} : { description }),
        tags,
        headingPath,
        content: piece.content,
        startLine,
        endLine,
        contentHash: sha256(piece.content),
      });
      ordinal += 1;
    }
  };

  for (const [lineIndex, line] of bodyLines.entries()) {
    const currentFenceLine = fenceLine(line);
    if (currentFenceLine !== undefined) {
      if (fence === undefined) {
        fence = { marker: currentFenceLine.marker, length: currentFenceLine.length };
      } else if (
        currentFenceLine.marker === fence.marker &&
        currentFenceLine.length >= fence.length &&
        /^\s*$/u.test(currentFenceLine.rest)
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;

    const heading = headingOnLine(line);
    if (heading === undefined) continue;

    addRegion(
      bodyLines.slice(segmentStart, lineIndex),
      segmentStart,
      headingStack.map(({ title: headingTitle }) => headingTitle),
    );
    while (headingStack.length > 0 && (headingStack.at(-1)?.level ?? 0) >= heading.level) headingStack.pop();
    headingStack.push({ level: heading.level, title: heading.title });
    latestHeadingPath = headingStack.map(({ title: headingTitle }) => headingTitle);
    segmentStart = lineIndex + 1;
  }
  addRegion(
    bodyLines.slice(segmentStart),
    segmentStart,
    headingStack.map(({ title: headingTitle }) => headingTitle),
  );

  if (chunks.length === 0) {
    chunks.push({
      id: sha256([path, latestHeadingPath.join(" / "), "0"].join("\0")),
      path,
      type,
      title,
      ...(description === undefined ? {} : { description }),
      tags,
      headingPath: latestHeadingPath,
      content: "",
      startLine: bodyStartLine,
      endLine: bodyStartLine,
      contentHash: sha256(""),
    });
  }

  return {
    path,
    relativePath,
    text: normalizedText,
    contentHash: sha256(normalizedText),
    frontmatter,
    type,
    title,
    ...(description === undefined ? {} : { description }),
    tags,
    body,
    chunks,
  };
};
