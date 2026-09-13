import { expect, test } from "bun:test";

import { MemoryParseError, parseMemory } from "./parse";

test("chunks H2 and H3 sections with line provenance", () => {
  const doc = parseMemory(
    "# Component Memory\n\n## Warnings\n\nDo not retry writes.\n\n### Database\n\nThe lock is intentional.\n",
    ".agents/memory.md",
  );

  expect(doc.chunks.map((chunk) => ({ headings: chunk.headingPath, start: chunk.startLine }))).toEqual([
    { headings: ["Warnings"], start: 5 },
    { headings: ["Warnings", "Database"], start: 9 },
  ]);
});

test("does not treat headings inside fenced code as sections", () => {
  const doc = parseMemory(
    "# Component Memory\n\n## Decisions\n\n```markdown\n## not a section\n```\n\nKeep the database lock.\n",
    ".agents/memory.md",
  );

  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]?.content).toContain("## not a section");
});

test("rejects invalid memory before returning partial content", () => {
  expect(() => parseMemory("## Warnings\n\nDo not retry.\n", ".agents/memory.md")).toThrow(MemoryParseError);
  expect(() => parseMemory("# Component Memory\n\n## Unknown\n\nBody\n", ".agents/memory.md")).toThrow(
    "unknown memory section",
  );
  expect(() => parseMemory("# Component Memory\n\n## Warnings\n\n\0", ".agents/memory.md")).toThrow(
    "invalid memory text",
  );
});

test("accepts the documented Purpose section in the initialized template", () => {
  expect(() =>
    parseMemory(
      "# Component Memory\n\n## Purpose\n\nDescribe the component.\n\n## Warnings\n\nKeep this warning.\n",
      ".agents/memory.md",
    ),
  ).not.toThrow();
});

test("splits long chunks without exceeding the documented bound", () => {
  const paragraph = "a".repeat(2_100);
  const doc = parseMemory(`# Component Memory\n\n## Learnings\n\n${paragraph}\n\n${paragraph}\n`, ".agents/memory.md");

  expect(doc.chunks).toHaveLength(2);
  expect(doc.chunks.every((chunk) => [...chunk.content].length <= 4_000)).toBe(true);
});
