import { expect, test } from "bun:test";
import { renderMemoryIndexes } from "./indexes";
import { parseConcept } from "./parse";

const concept = (path: `.agents/memory/${string}.md`, text: string) => parseConcept(text, path);

test("renders the prescribed component and Warning indexes exactly", () => {
  const concepts = [
    concept(
      ".agents/memory/component.md",
      "---\ntype: Component Overview\ntitle: Component overview\ndescription: Repository purpose, boundaries, and ownership.\n---\n\nPurpose.\n",
    ),
    concept(
      ".agents/memory/warnings/retries-can-duplicate-a-charge.md",
      "---\ntype: Warning\ntitle: Retries can duplicate a charge\ndescription: Reconcile a timeout before another write.\n---\n\nCheck the idempotency record.\n",
    ),
  ];

  const indexes = renderMemoryIndexes(concepts);

  expect(indexes.get(".agents/memory/index.md")).toBe(
    '---\nokf_version: "0.2"\n---\n\n# Component Memory\n\n- [Component overview](component.md): Repository purpose, boundaries, and ownership.\n- [Warnings](warnings/index.md): Traps, hazards, and costly failure modes.\n',
  );
  expect(indexes.get(".agents/memory/warnings/index.md")).toBe(
    "# Warnings\n\nTraps, hazards, and costly failure modes.\n\n## Warning\n\n- [Retries can duplicate a charge](retries-can-duplicate-a-charge.md): Reconcile a timeout before another write.\n",
  );
});

test("sorts titles case-insensitively with path as the tie-break and groups by type", () => {
  const concepts = [
    concept(".agents/memory/warnings/zulu.md", "---\ntype: Warning\ntitle: Zulu\n---\n\nClaim.\n"),
    concept(".agents/memory/warnings/same-b.md", "---\ntype: Warning\ntitle: Alpha\n---\n\nClaim.\n"),
    concept(".agents/memory/warnings/custom.md", "---\ntype: Risk Note\ntitle: Bravo\n---\n\nClaim.\n"),
    concept(".agents/memory/warnings/same-a.md", "---\ntype: Warning\ntitle: alpha\n---\n\nClaim.\n"),
  ];

  const warningIndex = renderMemoryIndexes(concepts).get(".agents/memory/warnings/index.md");

  expect(warningIndex).toBe(
    "# Warnings\n\nTraps, hazards, and costly failure modes.\n\n## Risk Note\n\n- [Bravo](custom.md)\n\n## Warning\n\n- [alpha](same-a.md)\n- [Alpha](same-b.md)\n- [Zulu](zulu.md)\n",
  );
});

test("omits description punctuation, falls back to file-stem titles, and is input-order independent", () => {
  const withoutDescription = concept(
    ".agents/memory/commands/retry-writes.md",
    "---\ntype: Command\n---\n\nRun the command.\n",
  );
  const withEscapedLabels = concept(
    ".agents/memory/commands/a-bracketed-rule.md",
    '---\ntype: Command\ntitle: "[Bracketed] rule"\ndescription: "First line\\nsecond line"\n---\n\nRule.\n',
  );
  const first = renderMemoryIndexes([withoutDescription, withEscapedLabels]);
  const reversed = renderMemoryIndexes([withEscapedLabels, withoutDescription]);

  expect(first).toEqual(reversed);
  expect(first.get(".agents/memory/commands/index.md")).toBe(
    "# Commands\n\nVerified commands for building, testing, checking, and running the component.\n\n## Command\n\n- [\\[Bracketed\\] rule](a-bracketed-rule.md): First line second line\n- [retry writes](retry-writes.md)\n",
  );
});

test("title-cases generic directories without inventing a description", () => {
  const indexes = renderMemoryIndexes([
    concept(
      ".agents/memory/team-notes/safe-rollback.md",
      "---\ntype: Operations Note\ntitle: Safe rollback\n---\n\nKeep the previous artifact.\n",
    ),
  ]);

  expect(indexes.get(".agents/memory/team-notes/index.md")).toBe(
    "# Team Notes\n\n## Operations Note\n\n- [Safe rollback](safe-rollback.md)\n",
  );
  expect(indexes.get(".agents/memory/index.md")).toBe(
    '---\nokf_version: "0.2"\n---\n\n# Component Memory\n\n- [Team Notes](team-notes/index.md)\n',
  );
});
