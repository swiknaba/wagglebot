import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { MemoryParseError, parseConcept } from "./parse";

const path = ".agents/memory/warnings/retry-writes.md" as const;
const relativePath = "warnings/retry-writes.md";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

test("parses the only required OKF field and derives the display title", () => {
  const concept = parseConcept(
    "---\ntype: Warning\nproducer_extension: keep-me\n---\n\n# Warning\n\nDo not retry.\n",
    path,
  );

  expect(concept).toMatchObject({
    path,
    relativePath,
    type: "Warning",
    title: "retry writes",
    frontmatter: { type: "Warning", producer_extension: "keep-me" },
  });
});

test("accepts unknown OKF values and reads correctly shaped optional fields", () => {
  const concept = parseConcept(
    '---\ntype: Vendor/Custom\ntitle: "  Curated title  "\ndescription: A short summary\ntags: [safe, durable]\nproducer_extension: keep-me\n---\n\nClaim.\n',
    path,
  );

  expect(concept).toMatchObject({
    type: "Vendor/Custom",
    title: "Curated title",
    description: "A short summary",
    tags: ["safe", "durable"],
    frontmatter: { producer_extension: "keep-me" },
  });
  expect(concept.chunks[0]).toMatchObject({
    path,
    type: "Vendor/Custom",
    title: "Curated title",
    description: "A short summary",
    tags: ["safe", "durable"],
  });
});

test("ignores wrong-shaped optional retrieval fields while preserving their frontmatter", () => {
  const concept = parseConcept(
    "---\ntype: Custom\ntitle: 17\ndescription: [not, a, string]\ntags: one\n---\n\nClaim.\n",
    path,
  );

  expect(concept).toMatchObject({
    title: "retry writes",
    tags: [],
    frontmatter: { title: 17, description: ["not", "a", "string"], tags: "one" },
  });
  expect(concept.description).toBeUndefined();
});

test("normalizes CRLF before storing and hashing concept text", () => {
  const crlfText = "---\r\ntype: Warning\r\n---\r\n\r\n# Warning\r\n\r\nRetry carefully.\r\n";
  const normalizedText = crlfText.replace(/\r\n?/gu, "\n");
  const concept = parseConcept(crlfText, path);

  expect(concept.text).toBe(normalizedText);
  expect(concept.contentHash).toBe(sha256(normalizedText));
  expect(concept.contentHash).not.toBe(sha256(crlfText));
});

test("tracks H1, H2, and H3 ancestry and exact body line numbers outside fenced code", () => {
  const text = [
    "---",
    "type: Warning",
    "---",
    "",
    "# Warning",
    "",
    "Top-level warning.",
    "",
    "## Retry writes",
    "",
    "Do not retry writes.",
    "",
    "### Database",
    "Lock stays held.",
    "",
    "```md",
    "# not a heading",
    "```",
    "",
    "Still database details.",
  ].join("\n");
  const concept = parseConcept(text, path);

  expect(
    concept.chunks.map(({ headingPath, startLine, endLine, content }) => ({
      headingPath,
      startLine,
      endLine,
      content,
    })),
  ).toEqual([
    {
      headingPath: ["Warning"],
      startLine: 7,
      endLine: 7,
      content: "Top-level warning.",
    },
    {
      headingPath: ["Warning", "Retry writes"],
      startLine: 11,
      endLine: 11,
      content: "Do not retry writes.",
    },
    {
      headingPath: ["Warning", "Retry writes", "Database"],
      startLine: 14,
      endLine: 20,
      content: "Lock stays held.\n\n```md\n# not a heading\n```\n\nStill database details.",
    },
  ]);
});

test("keeps a body without headings searchable", () => {
  const concept = parseConcept("---\ntype: Warning\n---\n\nDo not retry.\n\nKeep the lock.\n", path);

  expect(concept.chunks).toHaveLength(1);
  expect(concept.chunks[0]).toMatchObject({
    headingPath: [],
    content: "Do not retry.\n\nKeep the lock.",
    startLine: 5,
    endLine: 7,
  });
});

test("splits an oversized paragraph at no more than 4,000 Unicode code points", () => {
  const paragraph = "🪲".repeat(4_200);
  const concept = parseConcept(`---\ntype: Warning\n---\n\n${paragraph}\n`, path);

  expect(concept.chunks.length).toBeGreaterThan(1);
  expect(concept.chunks.every((chunk) => [...chunk.content].length <= 4_000)).toBe(true);
  expect(concept.chunks.map((chunk) => chunk.content).join("")).toBe(paragraph);
});

test("creates an empty searchable chunk at the first body line when the body is empty", () => {
  const concept = parseConcept("---\ntype: Warning\n---\n", path);

  expect(concept.chunks).toHaveLength(1);
  expect(concept.chunks[0]).toMatchObject({ content: "", startLine: 4, endLine: 4 });
});

test("uses deterministic IDs based on concept path, heading ancestry, and ordinal", () => {
  const concept = parseConcept("---\ntype: Warning\n---\n\n# Warning\n\nClaim.\n", path);

  expect(concept.chunks[0]?.id).toBe(sha256([path, "Warning", "0"].join("\0")));
  expect(concept.chunks[0]?.contentHash).toBe(sha256("Claim."));
});

test("rejects malformed YAML and missing or empty type without leaking YAML text", () => {
  const malformed = "---\ntype: Warning\nsecret: [TOP_SECRET\n---\n";
  const invalidConcepts = [
    { text: malformed, reason: "invalid frontmatter" },
    { text: "body only", reason: "invalid frontmatter" },
    { text: "---\ntitle: Missing type\n---\n", reason: "missing or invalid type" },
    { text: "---\ntype: ' '\n---\n", reason: "missing or invalid type" },
  ];

  for (const { text, reason } of invalidConcepts) {
    let thrown: unknown;
    try {
      parseConcept(text, path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MemoryParseError);
    expect((thrown as MemoryParseError).path).toBe(path);
    expect((thrown as Error).message).toBe(`${relativePath}: ${reason}`);
    expect((thrown as Error).message).not.toContain("TOP_SECRET");
    expect((thrown as Error).message).not.toContain(".agents/memory/");
  }
});

test("rejects NUL and replacement characters without returning partial content", () => {
  for (const invalidText of ["\0", "\uFFFD"]) {
    expect(() => parseConcept(`---\ntype: Warning\n---\n\n${invalidText}`, path)).toThrow(MemoryParseError);
  }
});
