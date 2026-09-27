import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

import type { LocalBrainError } from "../path-policy";
import { MarkdownMemoryProvider } from "./provider";
import { conceptText, fixtureRepo, writeConcept } from "./test-fixture";

const input = (projectRoot: string) => ({
  projectRoot,
  section: "Warnings" as const,
  title: "Retries can duplicate a charge",
  summary: "Do not retry a timed-out charge until its idempotency record is checked.",
  evidence: [{ kind: "file" as const, ref: "src/payments/charge.ts:74" }],
});

test("renders an OKF concept with stable evidence and sorted review changes without writing", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  const provider = new MarkdownMemoryProvider();

  const proposal = await provider.propose(input(repo));

  expect(proposal).toMatchObject({
    path: ".agents/memory/warnings/retries-can-duplicate-a-charge.md",
    section: "Warnings",
    title: "Retries can duplicate a charge",
    summary: "Do not retry a timed-out charge until its idempotency record is checked.",
    action: "add",
  });
  const frontmatterText = proposal.content.split("\n---\n")[0]?.slice(4) ?? "";
  const frontmatter = parseDocument(frontmatterText).toJS() as Record<string, unknown>;
  expect(frontmatter).toMatchObject({
    type: "Warning",
    title: "Retries can duplicate a charge",
    tags: ["warning"],
    status: "stable",
    sources: [
      {
        id: "evidence-1",
        resource: "../../../src/payments/charge.ts#L74",
        title: "src/payments/charge.ts:74",
        kind: "file",
      },
    ],
  });
  expect(proposal.content).toContain(
    "# Warning\n\nDo not retry a timed-out charge until its idempotency record is checked.[^evidence-1]\n\n[^evidence-1]: `src/payments/charge.ts:74`",
  );
  expect(proposal.indexChanges.map(({ path }) => path)).toEqual(
    [...proposal.indexChanges.map(({ path }) => path)].sort(),
  );
  expect(proposal.indexChanges.map(({ path }) => path)).toEqual([
    ".agents/memory/index.md",
    ".agents/memory/warnings/index.md",
  ]);
  expect(proposal.patch).toContain("--- a/.agents/memory/warnings/retries-can-duplicate-a-charge.md");
  expect(JSON.stringify(proposal)).not.toContain(repo);
  expect(JSON.stringify(proposal)).not.toContain("transcript");
  expect(await provider.propose(input(repo))).toEqual(proposal);
  expect(existsSync(join(repo, ".agents", "memory", "warnings", "retries-can-duplicate-a-charge.md"))).toBe(false);
  expect(existsSync(join(repo, ".agents", "memory", "index.md"))).toBe(false);
});

test("normalizes Unicode titles to lowercase ASCII kebab case and rejects an empty slug", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose({ ...input(repo), title: "Café déjà-vu" });
  expect(proposal.path).toBe(".agents/memory/warnings/cafe-deja-vu.md");
  await expect(provider.propose({ ...input(repo), title: "🪲" })).rejects.toMatchObject({
    code: "proposal_invalid",
  } satisfies Partial<LocalBrainError>);
});

test("supports each category mapping without changing the singular concept type", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  const provider = new MarkdownMemoryProvider();
  const categories = [
    ["Architecture", "architecture", "Architecture"],
    ["Conventions", "conventions", "Convention"],
    ["Commands", "commands", "Command"],
    ["Decisions", "decisions", "Decision"],
    ["Warnings", "warnings", "Warning"],
    ["Learnings", "learnings", "Learning"],
  ] as const;

  for (const [section, directory, type] of categories) {
    const proposal = await provider.propose({ ...input(repo), section, title: `Remember ${section}` });
    expect(proposal.path).toBe(`.agents/memory/${directory}/remember-${section.toLowerCase()}.md`);
    expect(proposal.content).toContain(`type: ${type}`);
  }
});

test("detects identical concepts and same-title conflicts across the whole bundle", async () => {
  const repo = fixtureRepo();
  writeConcept(
    repo,
    "warnings/retries-can-duplicate-a-charge.md",
    `---\ntype: Warning\ntitle: Retries can duplicate a charge\ndescription: ${input(repo).summary}\ntags: [warning]\nstatus: stable\nsources:\n  - id: evidence-1\n    resource: ../../../src/payments/charge.ts#L74\n    title: src/payments/charge.ts:74\n    kind: file\n---\n\n# Warning\n\n${input(repo).summary}[^evidence-1]\n\n[^evidence-1]: \`src/payments/charge.ts:74\`\n`,
  );
  const provider = new MarkdownMemoryProvider();
  const duplicate = await provider.propose(input(repo));
  expect(duplicate.action).toBe("no_change");
  expect(duplicate.patch).toBe("");
  expect(duplicate.indexChanges).toEqual([]);

  writeConcept(
    repo,
    "decisions/other-title-path.md",
    conceptText({
      type: "Decision",
      title: "Retries can duplicate a charge",
      body: "A different decision is recorded here.",
    }),
  );
  expect((await provider.propose(input(repo))).action).toBe("needs_resolution");
  expect((await provider.propose(input(repo))).path).toBe(".agents/memory/warnings/retries-can-duplicate-a-charge.md");
});

test("replacement requires exact path and content hash and preserves extension metadata", async () => {
  const repo = fixtureRepo();
  const targetPath = ".agents/memory/warnings/retries-can-duplicate-a-charge.md" as const;
  writeConcept(
    repo,
    "warnings/retries-can-duplicate-a-charge.md",
    `---\ntype: Warning\ntitle: Retries can duplicate a charge\ndescription: Old summary.\ntags: [old]\nstatus: draft\nsources: []\nresource: external/source\ngenerated: agent-name\nverified: true\nstale_after: 2027-01-01\nproducer_note: keep-me\n---\n\n# Warning\n\nOld claim.\n`,
  );
  const provider = new MarkdownMemoryProvider();
  const current = (await provider.read(repo))?.concepts[0];
  const proposal = await provider.propose({
    ...input(repo),
    replace: { path: targetPath, contentHash: current?.contentHash ?? "" },
  });
  const frontmatterText = proposal.content.split("\n---\n")[0]?.slice(4) ?? "";
  const frontmatter = parseDocument(frontmatterText).toJS() as Record<string, unknown>;

  expect(proposal.action).toBe("replace");
  expect(proposal.path).toBe(targetPath);
  expect(frontmatter).toMatchObject({
    type: "Warning",
    title: "Retries can duplicate a charge",
    status: "stable",
    tags: ["warning"],
    resource: "external/source",
    generated: "agent-name",
    verified: true,
    stale_after: "2027-01-01",
    producer_note: "keep-me",
  });
  expect(proposal.content).toContain("Do not retry a timed-out charge until its idempotency record is checked.");
  expect(
    (
      await provider.propose({
        ...input(repo),
        replace: { path: ".agents/memory/warnings/no.md" as never, contentHash: "a".repeat(64) },
      })
    ).action,
  ).toBe("needs_resolution");
  expect(
    (
      await provider.propose({
        ...input(repo),
        replace: { path: targetPath, contentHash: "a".repeat(64) },
      })
    ).action,
  ).toBe("needs_resolution");
});

test("rejects replacement of a root-level concept while keeping its path valid", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  const provider = new MarkdownMemoryProvider();
  const component = (await provider.read(repo))?.concepts.find(({ relativePath }) => relativePath === "component.md");
  expect(component?.path).toBe(".agents/memory/component.md");

  await expect(
    provider.propose({
      ...input(repo),
      replace: { path: ".agents/memory/component.md", contentHash: component?.contentHash ?? "" },
    }),
  ).rejects.toMatchObject({ code: "proposal_invalid" });
});

test("rejects replacement from a different category than the selected section", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "architecture/old-boundary.md", conceptText({ type: "Architecture", title: "Old boundary" }));
  const provider = new MarkdownMemoryProvider();
  const existing = (await provider.read(repo))?.concepts.find(
    ({ relativePath }) => relativePath === "architecture/old-boundary.md",
  );
  await expect(
    provider.propose({
      ...input(repo),
      replace: {
        path: ".agents/memory/architecture/old-boundary.md",
        contentHash: existing?.contentHash ?? "",
      },
    }),
  ).rejects.toMatchObject({ code: "proposal_invalid" });
});

test("enforces proposal bounds, safe references, and unknown-field rejection", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  const provider = new MarkdownMemoryProvider();
  await expect(provider.propose({ ...input(repo), title: "t".repeat(81) })).rejects.toMatchObject({
    code: "proposal_invalid",
  });
  await expect(provider.propose({ ...input(repo), title: "" })).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(provider.propose({ ...input(repo), summary: "s".repeat(1001) })).rejects.toMatchObject({
    code: "proposal_invalid",
  });
  await expect(provider.propose({ ...input(repo), summary: "" })).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(provider.propose({ ...input(repo), summary: "first line\nsecond line" })).rejects.toMatchObject({
    code: "proposal_invalid",
  });
  const upperBoundary = await provider.propose({
    ...input(repo),
    title: "T".repeat(80),
    summary: "s".repeat(1_000),
    evidence: Array.from({ length: 20 }, (_, index) => ({ kind: "file" as const, ref: `src/${index}.ts` })),
  });
  expect([...upperBoundary.title]).toHaveLength(80);
  expect([...upperBoundary.summary]).toHaveLength(1_000);
  expect(upperBoundary.evidence).toHaveLength(20);
  const lowerBoundary = await provider.propose({
    ...input(repo),
    title: "T",
    summary: "s",
    evidence: [{ kind: "file", ref: "src/source.ts" }],
  });
  expect(lowerBoundary.title).toBe("T");
  expect(lowerBoundary.summary).toBe("s");
  expect(lowerBoundary.evidence).toHaveLength(1);
  await expect(provider.propose({ ...input(repo), evidence: [] })).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(
    provider.propose({
      ...input(repo),
      evidence: Array.from({ length: 21 }, (_, index) => ({ kind: "file" as const, ref: `src/${index}.ts` })),
    }),
  ).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(
    provider.propose({ ...input(repo), evidence: [{ kind: "file", ref: "../outside.ts" }] }),
  ).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(
    provider.propose({ ...input(repo), evidence: [{ kind: "file", ref: "/private/source.ts" }] }),
  ).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(
    provider.propose({ ...input(repo), evidence: [{ kind: "file", ref: "src/source.ts", extra: true } as never] }),
  ).rejects.toMatchObject({ code: "proposal_invalid" });
  await expect(provider.propose({ ...input(repo), transcript: "do not persist" } as never)).rejects.toMatchObject({
    code: "proposal_invalid",
  });
  await expect(provider.propose({ ...input(repo), invented: "field" } as never)).rejects.toMatchObject({
    code: "proposal_invalid",
  });
});

test("uses portable scope descriptors for non-file evidence", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  const proposal = await new MarkdownMemoryProvider().propose({
    ...input(repo),
    evidence: [{ kind: "commit", ref: "abcdef123456" }],
  });
  expect(proposal.content).toContain("resource: commit:abcdef123456");
  expect(proposal.content).toContain("[^evidence-1]: `abcdef123456`");
});
