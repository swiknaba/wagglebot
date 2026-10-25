import { expect, test } from "bun:test";
import { parseKnowledgeDocument } from "./frontmatter";

const doc = (overrides = "") =>
  `---\nwagglebot:\n  schemaVersion: 1\n  scope: domain:payments\n  owner: team-payments\n  kind: convention\n  title: API\n  confidence: high${overrides}\n---\n# API\n\nUse exact bytes.\n`;

test("parses reviewed frontmatter and preserves the body byte-for-byte", () => {
  const parsed = parseKnowledgeDocument(doc());
  expect(parsed.metadata).toEqual({
    schemaVersion: 1,
    scope: { kind: "domain", name: "payments" },
    owner: "team-payments",
    kind: "convention",
    title: "API",
    confidence: "high",
    wake: false,
  });
  expect(parsed.body).toBe("# API\n\nUse exact bytes.\n");
});

test("rejects unknown frontmatter keys instead of ignoring a typo", () => {
  expect(() => parseKnowledgeDocument(doc("\n  scpoe: domain:payments"))).toThrow(/scpoe/);
});

test("requires wake review dates and accepts only known scopes", () => {
  expect(() => parseKnowledgeDocument(doc("\n  wake: true"))).toThrow(/reviewAfter/);
  expect(parseKnowledgeDocument(doc('\n  wake: true\n  reviewAfter: "2027-03-01"')).metadata.wake).toBe(true);
  expect(() => parseKnowledgeDocument(doc().replace("scope: domain:payments", "scope: component:checkout"))).toThrow(
    /scope/,
  );
});

test("rejects duplicate or malformed YAML and unknown root metadata", () => {
  expect(() => parseKnowledgeDocument(doc("\n  title: Duplicate"))).toThrow(/title/);
  expect(() => parseKnowledgeDocument(doc().replace("wagglebot:", "other:"))).toThrow(/unknown frontmatter key/);
});
