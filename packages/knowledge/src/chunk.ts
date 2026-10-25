import { chunkKey } from "./keys";

export type KnowledgeChunk = {
  chunkKey: string;
  heading: string;
  headingAncestry: string[];
  content: string;
  start: number;
  end: number;
};

const MAX_CONTENT_CODE_POINTS = 4_000;
const headingPattern = /^(#{1,6})[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/u;
const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})/u;
const fenceEndPattern = /^ {0,3}(`+|~+)[\t ]*$/u;

type Section = { heading: string; ancestry: string[]; occurrence: number; start: number; lines: string[] };

function lineParts(body: string): { text: string; start: number }[] {
  const lines: { text: string; start: number }[] = [];
  let start = 0;
  while (start < body.length) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline + 1;
    lines.push({ text: body.slice(start, end), start });
    start = end;
  }
  return lines;
}

function splitByCodePoints(text: string): string[] {
  const points = [...text];
  const pieces: string[] = [];
  for (let index = 0; index < points.length; index += MAX_CONTENT_CODE_POINTS) {
    pieces.push(points.slice(index, index + MAX_CONTENT_CODE_POINTS).join(""));
  }
  return pieces;
}

export function chunkKnowledgeDocument(body: string, source: string): KnowledgeChunk[] {
  if (body.length === 0) return [];
  const sections: Section[] = [];
  const stack: string[] = [];
  const occurrences = new Map<string, number>();
  let fence: { character: string; length: number } | undefined;
  let current: Section = { heading: "", ancestry: [], occurrence: 1, start: 0, lines: [] };
  sections.push(current);

  for (const line of lineParts(body)) {
    const withoutNewline = line.text.replace(/\r?\n$/u, "");
    if (fence) {
      const close = fenceEndPattern.exec(withoutNewline)?.[1];
      if (close?.[0] === fence.character && close.length >= fence.length) fence = undefined;
      current.lines.push(line.text);
      continue;
    }
    const open = fenceStartPattern.exec(withoutNewline)?.[1];
    if (open) {
      fence = { character: open[0] ?? "`", length: open.length };
      current.lines.push(line.text);
      continue;
    }
    const match = headingPattern.exec(withoutNewline);
    if (match) {
      const level = match[1]?.length ?? 1;
      const heading = withoutNewline;
      const parent = stack.slice(0, level - 1);
      const occurrenceKey = JSON.stringify([parent, heading]);
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      stack.length = level - 1;
      stack.push(heading);
      current = { heading, ancestry: [...stack], occurrence, start: line.start, lines: [] };
      sections.push(current);
    }
    current.lines.push(line.text);
  }

  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    let content = "";
    let start = section.start;
    let ordinal = 0;
    const push = () => {
      if (!content) return;
      chunks.push({
        chunkKey: chunkKey(source, section.ancestry, section.occurrence, ordinal++),
        heading: section.heading,
        headingAncestry: [...section.ancestry],
        content,
        start,
        end: start + content.length,
      });
      start += content.length;
      content = "";
    };

    for (const line of section.lines) {
      if ([...line].length > MAX_CONTENT_CODE_POINTS) {
        push();
        for (const piece of splitByCodePoints(line)) {
          content = piece;
          push();
        }
        continue;
      }
      if (content && [...content].length + [...line].length > MAX_CONTENT_CODE_POINTS) push();
      content += line;
    }
    push();
  }
  return chunks;
}
