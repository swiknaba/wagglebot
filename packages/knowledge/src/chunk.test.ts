import { expect, test } from "bun:test";
import { chunkKnowledgeDocument } from "./chunk";
import { sourceKey } from "./keys";

const source = sourceKey("company", "company/knowledge/api.md", "domain:payments");

test("chunks preserve every body character in order and retain heading lines", () => {
  const body = "Preamble\r\n\r\n# Root\r\nalpha\r\n## Child\r\nbeta\r\n";
  const chunks = chunkKnowledgeDocument(body, source);
  expect(chunks.map((chunk) => chunk.content).join("")).toBe(body);
  expect(chunks.some((chunk) => chunk.content.startsWith("## Child\r\n"))).toBe(true);
  expect(chunks.map((chunk) => chunk.heading)).toEqual(["", "# Root", "## Child"]);
  expect(new Set(chunks.map((chunk) => chunk.chunkKey)).size).toBe(chunks.length);
});

test("stable keys use heading ancestry, repeated-heading occurrence and segment ordinal", () => {
  const before = chunkKnowledgeDocument("# A\none\n## Repeat\nold\n## Repeat\ntwo\n", source);
  const after = chunkKnowledgeDocument("# A\none edited\n## Repeat\nnew\n## Repeat\ntwo\n", source);
  expect(after.map((chunk) => chunk.chunkKey)).toEqual(before.map((chunk) => chunk.chunkKey));
  expect(after[1]?.chunkKey).not.toBe(after[2]?.chunkKey);
});

test("splits at line boundaries and hard-splits by Unicode code point only", () => {
  const body = `${"a".repeat(3_999)}\n😀😀\n`;
  const chunks = chunkKnowledgeDocument(body, source);
  expect(chunks.map((chunk) => chunk.content).join("")).toBe(body);
  expect(chunks.every((chunk) => [...chunk.content].length <= 4_000)).toBe(true);
  const longLine = "😀".repeat(4_001);
  const split = chunkKnowledgeDocument(longLine, source);
  expect(split.map((chunk) => chunk.content).join("")).toBe(longLine);
  expect(split.map((chunk) => [...chunk.content].length)).toEqual([4_000, 1]);
});

test("empty body produces a complete empty publication", () => {
  expect(chunkKnowledgeDocument("", source)).toEqual([]);
});

test("Markdown-looking lines inside fenced code do not alter heading ancestry", () => {
  const body = "# Real heading\n```sh\n# shell comment\necho hi\n```\nAfter example.\n";
  const chunks = chunkKnowledgeDocument(body, source);
  expect(chunks.map((chunk) => chunk.content).join("")).toBe(body);
  expect(chunks.map((chunk) => chunk.heading)).toEqual(["# Real heading"]);
  expect(chunks[0]?.headingAncestry).toEqual(["# Real heading"]);
});
