# OKF Local Component Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `.agents/memory.md` implementation with a conformant, committed OKF v0.2 bundle whose concepts are individually readable and editable, while preserving Ludwig's automatic project scaffolding and agent-owned Git-review workflow.

**Architecture:** `@wagglebot/local-brain` owns one shared bundle lifecycle used by project `init`, project `update`, the hidden `sync-project` alias, and `brain init`. Focused modules parse concepts, load bounded bundles, render derived indexes, search authoritative concepts, and propose/save one concept atomically; the CLI and MCP layers only adapt those interfaces. The removed file is rejected, never migrated or read.

**Tech Stack:** TypeScript 5.9.2, Bun, Node.js filesystem APIs, YAML 2.8.3, Zod 4.6.1, the existing in-process BM25 implementation, the existing secret scanner, Biome 2.2.0.

**Spec:** `docs/superpowers/specs/2026-09-26-okf-local-memory-design.md`

## Global Constraints

- Every implementation and fix subagent for this plan uses `gpt-6-luna` with reasoning effort `xhigh`, as requested. A fresh subagent implements each task; subagents never dispatch their own subagents.
- Plan/design audits, task reviews, scoped re-reviews, and final review use `gpt-5.6-sol` with reasoning effort `xhigh`.
- Follow test-driven development: add the named behavioral tests, run them and capture the expected failure, then implement the minimum behavior and re-run the same command.
- `.agents/memory/` is the only supported component-memory location. If `.agents/memory.md` exists, fail with `local_memory_invalid`; never read, migrate, copy, rename, overwrite, or delete it.
- OKF v0.2 requires only a parseable YAML frontmatter mapping with a non-empty string `type`. Accept unknown types, unknown frontmatter keys, missing optional fields, and broken Markdown links.
- A normalized direct-child concept path such as `.agents/memory/component.md` is valid for loading, search, and evidence. `brain_memory_propose` replacement is category-bound: its selected section must match the replacement path's category directory; the root component scaffold and cross-category concepts are not replaceable through that proposal API.
- Preserve unknown frontmatter keys and optional OKF trust/freshness keys when replacing a concept. Re-serialization need not preserve YAML comments or formatting.
- The total bytes of all Markdown files in the bundle, including reserved indexes and logs, must not exceed 256 KiB. Every search chunk must contain at most 4,000 Unicode code points.
- Recursively inspect Markdown files without following symlinks. Reject any symlink or resolved escape with `path_outside_repository`.
- Authoritative concepts are every non-reserved `.md` file. `index.md` and `log.md` are never searched and never contribute to `bundleHash`.
- `bundleHash` is SHA-256 over sorted `(bundle-relative concept path, concept contentHash)` pairs. Repairing derived indexes must not change it.
- Root and category indexes are deterministic derived files. They are generated from concept frontmatter and paths without a model or network call.
- Proposals are ephemeral, transcript-free, deterministic, secret-scanned, and identified by all of their save-relevant fields. Save revalidates the proposal against the current bundle and scans the final concept again.
- Save writes the concept atomically before indexes. An index-write failure leaves the concept durable and returns exactly one `indexes_stale` warning.
- Project `init` and `update` preserve existing concepts and `.agents/changelog.md`. They create scaffolding even when `.agents/instructions/` has no Markdown files and never add memory or changelog paths to `.gitignore`.
- Agents read `.agents/memory/index.md` first, open only relevant concepts, keep one durable concept per file, run `wagglebot update` after direct edits, and commit concepts plus derived indexes for human review.
- Do not add dependencies. `yaml` is already pinned to `2.8.3` in `@wagglebot/local-brain` and the CLI.
- Never stage or commit repository memory from a runtime command. Code-task commits named below contain only implementation, tests, documentation, and deliberate fixture changes.
- Errors and logs may contain repository-relative concept paths, states, counts, hashes, and durations. They must not contain absolute roots, concept bodies, queries, secrets, or raw YAML parser output.
- Preserve all unrelated work and leave the untracked `.idea/` directory untouched.

---

## File Structure

The finished implementation uses these responsibilities:

```text
packages/local-brain/src/memory/
  parse.ts       Parse one OKF concept and chunk its Markdown body.
  bundle.ts      Recursively load/validate a bounded bundle and compute bundleHash.
  indexes.ts     Render, compare, repair, and remove only derived index.md files.
  lifecycle.ts   Create the initial component concept and invoke bundle/index repair.
  proposal.ts    Validate inputs, render one concept, detect conflicts, and build a multi-file patch.
  provider.ts    Cache/search bundles and perform propose/save orchestration.
  write.ts       Existing atomic single-file writer.
  test-fixture.ts  Create isolated Git repositories and OKF bundle fixtures.
```

Do not combine bundle traversal, index rendering, and proposal logic into one large file. Do not introduce a local database, watcher, background task, model call, or migration utility.

---

### Task 1: Define OKF concept types and parse one concept

**Execution status:** Complete and reviewed (`2fe9fb2..c826592`).

**Files:**

- Modify: `packages/local-brain/src/types.ts`
- Modify: `packages/local-brain/src/memory/parse.ts`
- Replace: `packages/local-brain/src/memory/parse.test.ts`
- Modify: `packages/local-brain/src/memory/test-fixture.ts`
- Modify: `packages/local-brain/src/index.ts`

**Interfaces:**

- Consumes: YAML 2.8.3 and the existing SHA-256/chunking behavior.
- Produces these exact public types and parser:

```ts
export type LocalMemoryPath = `.agents/memory/${string}.md`;
export type LocalMemoryIndexState = "current" | "stale" | "missing";

export type LocalMemoryChunk = {
  id: string;
  path: LocalMemoryPath;
  type: string;
  title: string;
  description?: string;
  tags: string[];
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};

export type LocalMemoryConcept = {
  path: LocalMemoryPath;
  relativePath: string;
  text: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  type: string;
  title: string;
  description?: string;
  tags: string[];
  body: string;
  chunks: LocalMemoryChunk[];
};

export class MemoryParseError extends Error {
  constructor(readonly path: LocalMemoryPath, message: string);
}

export function parseConcept(text: string, path: LocalMemoryPath): LocalMemoryConcept;
```

`title` is the trimmed string frontmatter title when present and non-empty; otherwise it is the final file stem with hyphens converted to spaces. `description` and `tags` are consumed only when they have the expected shape; an optional field with another YAML type is preserved in `frontmatter` and ignored by retrieval rather than making the concept invalid.

For Task 1's intermediate compile, `MemoryParseError` may temporarily overload
the existing one-argument constructor used by `parseMemory`. Task 3 deletes the
old parser and leaves only the exact path-plus-message constructor above.

- [x] **Step 1: Replace parser tests with OKF conformance tests**

Cover all of these observable cases in `parse.test.ts`:

```ts
const path = ".agents/memory/warnings/retry-writes.md" as const;

test("parses the only required OKF field and derives the display title", () => {
  const concept = parseConcept("---\ntype: Warning\nproducer_extension: keep-me\n---\n\n# Warning\n\nDo not retry.\n", path);
  expect(concept).toMatchObject({
    path,
    relativePath: "warnings/retry-writes.md",
    type: "Warning",
    title: "retry writes",
    frontmatter: { type: "Warning", producer_extension: "keep-me" },
  });
});

test("rejects malformed YAML and missing or empty type without leaking YAML text", () => {
  for (const text of ["body only", "---\ntitle: Missing type\n---\n", "---\ntype: ' '\n---\n"])
    expect(() => parseConcept(text, path)).toThrow(MemoryParseError);
});
```

Also assert:

- CRLF normalizes to LF before hashing.
- unknown `type` and unknown keys are accepted;
- wrong-shaped optional `title`, `description`, or `tags` is tolerated;
- headings inside fenced code are not parsed as structure;
- normal H1/H2/H3 ancestry and exact body line numbers are returned;
- a concept with no heading still yields one searchable chunk;
- a 4,200-code-point paragraph splits into chunks of at most 4,000 code points;
- NUL and replacement characters fail;
- the error message contains only the relative concept path plus a stable reason, not raw YAML.

- [x] **Step 2: Run the parser tests and capture RED**

Run: `bun test packages/local-brain/src/memory/parse.test.ts`

Expected: FAIL because `parseConcept`, `LocalMemoryPath`, and OKF frontmatter parsing do not exist.

- [x] **Step 3: Implement the types and parser**

Use `parseDocument` from `yaml`. Require frontmatter delimiters on their own lines at byte zero, require `document.errors.length === 0`, require `toJS()` to be a non-array object, and require only a trimmed non-empty string `type`. Normalize newlines before computing hashes.

Parse Markdown headings outside fenced code. Split non-empty body regions at paragraph, sentence, newline, or space boundaries without exceeding 4,000 code points. If the body has no non-empty region, create a single chunk with empty `content`, `startLine` and `endLine` set to the first body line, so type/title metadata remains indexable later. Chunk IDs hash `[path, headingPath.join(" / "), ordinal]` separated by NUL.

Add these helpers to `test-fixture.ts` for later tasks while temporarily
retaining the existing helpers until Task 3:

```ts
export const fixtureRepo = (): string;
export const conceptText = (input?: {
  type?: string;
  title?: string;
  description?: string;
  body?: string;
  extra?: string;
}): string;
export const writeConcept = (root: string, relative: string, text: string): string;
```

`writeConcept(repo, "warnings/retry-writes.md", text)` writes to `.agents/memory/warnings/retry-writes.md` and returns that absolute path. Do not create a legacy file helper.

Export `parseConcept`, `LocalMemoryConcept`, and `LocalMemoryPath` from
`packages/local-brain/src/index.ts`. Keep the existing single-file parser,
types, fixture helpers, and exports unchanged for this intermediate commit so
unconverted callers still compile. Task 3 deletes them in the same commit that
replaces their last callers. This is sequencing only: no new runtime path calls
the old parser, and the final branch exposes no legacy compatibility API.

- [x] **Step 4: Run focused validation**

Run: `bun test packages/local-brain/src/memory/parse.test.ts && bun run check && bun run typecheck`

Expected: parser tests pass, Biome is clean, and TypeScript passes because the
existing single-file interfaces remain temporarily available to unchanged
callers.

- [x] **Step 5: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/memory/parse.ts packages/local-brain/src/memory/parse.test.ts packages/local-brain/src/memory/test-fixture.ts packages/local-brain/src/index.ts
git commit -m "feat(memory): parse OKF concepts"
```

---

### Task 2: Load bundles, render indexes, and share one lifecycle

**Execution status:** Complete, including private path rejection and scoped link/fence fixes (`c826592..79f5812`; follow-up review clean).

**Files:**

- Create: `packages/local-brain/src/memory/bundle.ts`
- Create: `packages/local-brain/src/memory/bundle.test.ts`
- Create: `packages/local-brain/src/memory/indexes.ts`
- Create: `packages/local-brain/src/memory/indexes.test.ts`
- Create: `packages/local-brain/src/memory/lifecycle.ts`
- Create: `packages/local-brain/src/memory/lifecycle.test.ts`
- Modify: `packages/local-brain/src/types.ts`
- Modify: `packages/local-brain/src/memory/write.ts`
- Modify: `packages/local-brain/src/index.ts`

**Interfaces:**

- Consumes: `parseConcept`, `writeMemoryAtomically`, `LocalBrainError`, and a canonical Git root.
- Produces:

```ts
export type LocalMemoryReservedFile = {
  path: LocalMemoryPath;
  text: string;
  contentHash: string;
};

export type LocalMemoryBundle = {
  path: ".agents/memory";
  concepts: LocalMemoryConcept[];
  indexes: LocalMemoryReservedFile[];
  logs: LocalMemoryReservedFile[];
  bundleHash: string;
  totalBytes: number;
  indexState: LocalMemoryIndexState;
};

export const INITIAL_COMPONENT_PATH = ".agents/memory/component.md" as const;

export function loadMemoryBundle(projectRoot: string): LocalMemoryBundle | undefined;
export function renderMemoryIndexes(concepts: LocalMemoryConcept[]): Map<LocalMemoryPath, string>;
export function repairMemoryIndexes(
  projectRoot: string,
  bundle: LocalMemoryBundle,
  write?: (target: string, content: string) => void,
): LocalMemoryBundle;
export function ensureLocalMemoryBundle(projectRoot: string): LocalMemoryBundle;
```

The rejection guard for `.agents/memory.md` is private to `bundle.ts`; do not
export a legacy-path constant. That file is unsupported and the public API must
not imply that it is a supported memory location.

- [x] **Step 1: Write failing bundle-loader tests**

In `bundle.test.ts`, build real temporary Git repositories and assert:

- missing `.agents/memory/` returns `undefined` only when `.agents/memory.md` is also absent;
- a legacy file produces `LocalBrainError` with `code: "local_memory_invalid"` and guidance naming `.agents/memory/`;
- concepts are recursively sorted by POSIX relative path;
- `index.md` and `log.md` are reserved, not concepts;
- all Markdown bytes, including reserved files, count toward 256 KiB;
- only sorted concept path/hash pairs affect `bundleHash`;
- changing `index.md` or `log.md` leaves `bundleHash` unchanged;
- malformed root or nested concepts identify only the repository-relative path;
- a symlinked file or directory is rejected with `path_outside_repository`;
- `log.md` accepts a heading plus ISO `YYYY-MM-DD` H2 headings and rejects non-date H2 headings;
- `log.md` fence parsing honors the opening marker character and run length, so a triple-backtick line inside a four-backtick code block does not expose its contents as headings;
- a root `index.md` with malformed YAML or a declared version other than string `"0.2"` is invalid; a category index with frontmatter is invalid.

- [x] **Step 2: Write failing deterministic-index tests**

In `indexes.test.ts`, create component, Warning, and two custom-type concepts. Assert the exact generated shape:

```md
---
okf_version: "0.2"
---

# Component Memory

- [Component overview](component.md): Repository purpose, boundaries, and ownership.
- [Warnings](warnings/index.md): Traps, hazards, and costly failure modes.
```

and:

```md
# Warnings

Traps, hazards, and costly failure modes.

## Warning

- [Retries can duplicate a charge](retries-can-duplicate-a-charge.md): Reconcile a timeout before another write.
```

Assert case-insensitive title sorting with path as the final tie-break, grouping by `type`, omitted description punctuation when no description exists, file-stem fallback titles, deterministic output regardless of input order, generic title-cased directory names with no invented description, and exclusion of `log.md`.

Also include a concept filename containing a space and assert the generated
Markdown link destination percent-encodes the space so GitHub/standard Markdown
resolves the target.

- [x] **Step 3: Write failing lifecycle tests**

In `lifecycle.test.ts`, assert:

```ts
const bundle = ensureLocalMemoryBundle(repo);
expect(bundle.path).toBe(".agents/memory");
expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).toContain('okf_version: "0.2"');
expect(readFileSync(join(repo, ".agents/memory/component.md"), "utf8")).toContain("type: Component Overview");
expect(readFileSync(join(repo, ".agents/memory/component.md"), "utf8")).toContain("status: draft");
```

Run twice and prove component bytes are unchanged. Add a human concept and a valid `log.md`, corrupt an index, run again, and prove only the index changed. Create `.agents/memory.md`, then prove the command throws before creating `.agents/memory/`.

- [x] **Step 4: Run all new tests and capture RED**

Run: `bun test packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.test.ts`

Expected: FAIL because the three modules and public interfaces do not exist.

- [x] **Step 5: Implement bounded traversal and reserved-file validation**

Use `lstatSync`/`readdirSync({ withFileTypes: true })` and never call a traversal API that follows a discovered symlink. Resolve the repository and bundle roots once; reject any discovered symbolic link before reading it. Normalize all public paths to POSIX separators.

Count bytes while reading each `.md` file and stop with `local_memory_too_large` as soon as the running total exceeds `256 * 1024`. Ignore non-Markdown regular files for this v1 consumer. Validate reserved files without treating their content as concepts. Sort concepts, indexes, and logs before returning.

Compute:

```ts
const bundleHash = sha256(
  concepts.map((concept) => `${concept.relativePath}\0${concept.contentHash}`).sort().join("\0"),
);
```

An empty existing bundle uses the SHA-256 of the empty string. It is valid but does not receive a component concept; only a wholly missing bundle gets the initial component.

- [x] **Step 6: Implement deterministic indexes and repair**

Generate one `index.md` for the root and every directory that contains a direct concept or a populated child directory. Root frontmatter is exactly `okf_version: "0.2"`; nested indexes have no frontmatter. Known category titles/descriptions are:

```ts
const CATEGORY_DESCRIPTIONS = {
  architecture: "Durable structural constraints and boundaries.",
  conventions: "Repository-specific rules that source code does not state.",
  commands: "Verified commands for building, testing, checking, and running the component.",
  decisions: "Accepted choices and the evidence or rationale behind them.",
  warnings: "Traps, hazards, and costly failure modes.",
  learnings: "Durable, verified lessons that should survive the current session.",
} as const;
```

The root component description is `Repository purpose, boundaries, and ownership.`. Use Markdown `-` bullets and `: description` exactly as shown. Escape `[` and `]` in link labels and replace line breaks in displayed titles/descriptions with spaces.

`repairMemoryIndexes` writes only changed expected indexes through `writeMemoryAtomically` and removes only obsolete files whose basename is exactly `index.md`. It never writes or deletes a concept or `log.md`. Re-load before returning so `indexState` is `current`.

- [x] **Step 7: Implement the shared initializer**

The exact initial concept is:

```md
---
type: Component Overview
title: Component overview
description: Repository purpose, boundaries, and ownership.
status: draft
tags: [component]
---

# Component Overview

Replace this draft with the repository's purpose, boundaries, and ownership.
```

`ensureLocalMemoryBundle` performs the legacy-file preflight first. When the bundle is absent, create its directory, atomically write only `component.md`, load it, and repair indexes. When present, load and repair indexes without adding or replacing concepts.

- [x] **Step 8: Run focused validation**

Run: `bun test packages/local-brain/src/memory/parse.test.ts packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.test.ts && bun run check && bun run typecheck`

Expected: all focused tests, formatting, and types pass.

- [x] **Step 9: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/index.ts packages/local-brain/src/memory/bundle.ts packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.ts packages/local-brain/src/memory/lifecycle.test.ts packages/local-brain/src/memory/write.ts
git commit -m "feat(memory): load and initialize OKF bundles"
```

---

### Task 3: Replace local memory search, proposal, save, and status

**Execution status:** Complete, reviewed and re-reviewed (`23baae2`, `0940134`; plan clarifications in `f358a03`, `46461ab`).

**Files:**

- Replace: `packages/local-brain/src/memory/provider.ts`
- Replace: `packages/local-brain/src/memory/provider.test.ts`
- Replace: `packages/local-brain/src/memory/proposal.ts`
- Replace: `packages/local-brain/src/memory/proposal.test.ts`
- Replace: `packages/local-brain/src/memory/write.test.ts`
- Modify: `packages/local-brain/src/memory/parse.ts`
- Modify: `packages/local-brain/src/memory/test-fixture.ts`
- Modify: `packages/local-brain/src/index.ts`
- Modify: `packages/local-brain/src/local-brain.ts`
- Modify: `packages/local-brain/src/local-brain.test.ts`
- Modify: `packages/local-brain/src/types.ts`
- Modify: `packages/cli/src/commands/brain-remember.ts`
- Modify: `packages/cli/src/commands/brain-remember.test.ts`
- Modify: `packages/cli/src/commands/brain-status.ts`
- Modify: `packages/cli/src/commands/brain-status.test.ts`
- Modify: `packages/contracts/src/base.ts`
- Modify: `packages/contracts/src/base.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `services/context-engine/src/mcp/low-level.ts`
- Modify: `services/context-engine/src/mcp/low-level.test.ts`

**Interfaces:**

- Consumes: Task 1's `parseConcept`, Task 2's bundle loader/index repair/lifecycle, existing `Bm25Index`, `assertSafeText`, and atomic writer.
- Produces `LocalMemoryHit = LocalMemoryChunk & { score: number }`, `LocalMemorySearchResult = { hits: LocalMemoryHit[]; bundleHash?: string }`, `MarkdownMemoryProvider.read(): Promise<LocalMemoryBundle | undefined>`, the proposal/save types below, and this status shape:

```ts
export type LocalBrainStatus = {
  project: ProjectIdentity;
  memory: {
    path: ".agents/memory";
    state: "missing" | "ready" | "invalid" | "error";
    bundleHash?: string;
    conceptCount?: number;
    totalBytes?: number;
    indexState?: LocalMemoryIndexState;
    observedAt: string;
  };
  codeGraph: CodeGraphStatus;
  git: GitStatus;
  observedAt: string;
};
```

The `invalid` state covers `local_memory_invalid`, `local_memory_too_large`, and `path_outside_repository`; unexpected I/O/internal failures use `error`. Missing bundle is `missing`. A memory failure must not change CodeGraph or Git state.

`MarkdownMemoryProvider.search()` and `LocalBrain["memory"].search()` return `Promise<LocalMemorySearchResult>`. `LocalBrain["memory"]` publicly exposes `read`, `search`, `propose`, and `save` without a union that hides operations or caller-side unsafe casts. The provider loads one bundle snapshot, searches only that snapshot's concepts, and returns that same snapshot's `bundleHash` with the hits. A missing bundle returns empty hits and no hash. MCP consumes this envelope directly; it must not call `read()` after search, which could pair results from different snapshots.

The final proposal/save types are:

```ts
export type LocalMemoryProposalInput = {
  projectRoot: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { path: LocalMemoryPath; contentHash: string };
};

export type LocalMemoryIndexChange = { path: LocalMemoryPath; content: string };

export type LocalMemoryProposal = {
  proposalId: string;
  baseBundleHash: string;
  path: LocalMemoryPath;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { path: LocalMemoryPath; contentHash: string };
  action: "add" | "replace" | "no_change" | "needs_resolution";
  content: string;
  indexChanges: LocalMemoryIndexChange[];
  patch: string;
  warnings: string[];
};

export type LocalMemorySaveResult = {
  path: LocalMemoryPath;
  action: "add" | "replace";
  previousBundleHash: string;
  newBundleHash: string;
  patch: string;
  warnings: string[];
};
```

- [x] **Step 1: Write failing OKF search, status, proposal, and save tests**

Search across at least three concepts in different directories. Assert exact concept paths; matching across type/title/description/tags/headings/body; exact source lines and chunk hash; indexes/logs excluded; changing concepts changes the search cache key; changing only indexes does not change search; and missing, legacy, malformed, oversize, and symlink cases return the documented outcomes.

The general concept-path contract accepts a direct-child concept such as `.agents/memory/component.md` for evidence and search. Proposal replacement is narrower: it requires an existing exact `{ path, contentHash }` under the category directory mapped from the selected section. Assert root-level `component.md` and a concept in a different category are rejected as `proposal_invalid` for replacement; the replacement path is never moved or re-slugged. Mirror every `RelativePathSchema` security rule at both the MCP and local proposal boundaries: reject NUL, absolute paths, backslashes, empty/dot/traversal segments, `.env*` segments, `.pem`/`.key` basenames, `credentials`/`secrets` segments, and reserved `index.md`/`log.md`; use matching positive and negative cases at the contracts, MCP, and local proposal boundaries.

Assert each search result's hits and `bundleHash` are from one bundle snapshot. A regression must mutate the on-disk concept immediately after a provider search and show the returned hash still matches the content that produced its hits; the MCP handler must return the provider envelope without a second `read()`.

The limit-boundary test must include an equal-score exact title/heading match just below BM25's score-only cutoff and a lower-score item. Assert the exact match wins only the equal-score tie, while the lower-scored result stays behind higher scores. Request all scored chunks from `Bm25Index`, sort by score descending, exact title/heading match descending, stable chunk ID ascending, and only then apply `slice(0, limit)`; do not truncate before the provider tie-break. MCP must enforce the same `1..2,000` Unicode-code-point query bound as the provider, not JavaScript UTF-16 string length.

For status, return a fake bundle with two concepts, `bundleHash: "a".repeat(64)`, `totalBytes: 512`, and `indexState: "stale"`; assert status carries path `.agents/memory`, ready state, those metadata, and observed time. Cover missing bundle → `missing`; `local_memory_invalid`, `local_memory_too_large`, and `path_outside_repository` → `invalid`; unexpected I/O/internal failure → `error`; and independent CodeGraph/Git failures remaining isolated. Update `brain-status.ts` and its tests in this task so the new public `LocalBrainStatus` is a typecheck-clean boundary.

The `brain status` text and typed JSON tests must show `.agents/memory`, concept count, bundle hash, index state, and the exact `LocalBrainStatus.memory` path/state fields.

Assert exact category/type mappings:

```ts
const CATEGORY = {
  Architecture: ["architecture", "Architecture"],
  Conventions: ["conventions", "Convention"],
  Commands: ["commands", "Command"],
  Decisions: ["decisions", "Decision"],
  Warnings: ["warnings", "Warning"],
  Learnings: ["learnings", "Learning"],
} as const;
```

For proposal input:

```ts
export type LocalMemoryProposalInput = {
  projectRoot: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { path: LocalMemoryPath; contentHash: string };
};
```

For a title `Retries can duplicate a charge`, assert target
`.agents/memory/warnings/retries-can-duplicate-a-charge.md`, `type: Warning`,
`status: stable`, tag `[warning]`, stable `evidence-1`, and this semantic body:

```md
# Warning

Do not retry a timed-out charge until its idempotency record is checked.[^evidence-1]

[^evidence-1]: `src/payments/charge.ts:74`
```

The corresponding source entry is exactly:

```yaml
- id: evidence-1
  resource: ../../../src/payments/charge.ts#L74
  title: src/payments/charge.ts:74
  kind: file
```

Also assert:

- NFKD normalization yields lowercase ASCII kebab-case and an empty slug is `proposal_invalid`;
- 1..80 title, 1..1,000 one-line summary, 1..20 evidence, safe relative refs, and existing transcript/unknown-field rejection remain enforced;
- no file is written during proposal;
- generated root/category `indexChanges` and unified patch are deterministic and sorted by path;
- exact duplicate is `no_change` with an empty patch;
- same-title conflict anywhere in the bundle is `needs_resolution`; no numeric suffix is selected;
- replacement requires exact concept path and `contentHash`, and the path's category directory must match the selected section;
- replacement of root-level `.agents/memory/component.md` or a concept from a different category is rejected as `proposal_invalid`, while the general concept-path schema accepts `.agents/memory/component.md` for evidence/search;
- replacement preserves unknown frontmatter keys and optional OKF fields `resource`, `generated`, `verified`, and `stale_after`, while replacing `type`, `title`, `description`, `tags`, `status`, `sources`, and body with proposal-owned values;
- proposal generation secret-scans the complete rendered concept, including preserved unknown frontmatter, before returning any content or patch; save repeats the scan immediately before writing;
- a non-file evidence descriptor such as `issue: OPS-1:0` preserves its full resource suffix; optional trailing line-number parsing applies only to `file` and `adr` evidence;
- proposal JSON contains no transcript or absolute root;
- category directories absent in a new bundle are created safely before atomic concept write, and if that write fails, only the newly created empty directory is cleaned up (never a pre-existing directory);
- a projected total above 256 KiB is rejected before any writer call. Preflight simulates every deterministic index-write prefix after the concept becomes durable, including old stale or obsolete indexes that still exist until cleanup, all concepts, logs, and generated indexes; no possible durable partial-repair state may exceed the cap or make the saved concepts unreadable.

Save tests must assert:

- concurrent concept change causes `memory_changed` through `baseBundleHash`;
- a proposal still saves successfully after only a derived index changes, and indexes regenerate from current authoritative concepts;
- tampering with proposal ID or semantic fields (`baseBundleHash`, `path`, `section`, `content`, action, evidence, title, summary, replacement) is rejected as `proposal_invalid` before reporting a bundle conflict;
- altered submitted `indexChanges` or `patch` without a matching submitted proposal ID is rejected; unchanged proposal data remains valid after index-only drift and saves with regenerated derived output;
- derived `indexChanges` and `patch` are regenerated from current concepts/indexes at save, so index-only drift is accepted without trusting stale derived output;
- the review `patch` includes obsolete generated-index deletions that lifecycle repair will perform, using deletion hunks, even though `indexChanges` contains only generated index writes;
- a final-content secret is rejected before the writer runs;
- successful add writes one concept and affected indexes, returns old/new bundle hashes, and never stages/commits;
- successful replacement uses only the selected concept identity;
- save rejects `no_change` as `proposal_invalid` and `needs_resolution` as `proposal_conflict` before any write;
- concept-write failure leaves originals intact;
- index-write failure after a durable concept returns `warnings: ["indexes_stale"]`, keeps the concept readable/searchable, and returns the actual new bundle hash;
- near the 256 KiB limit, stale and obsolete index files plus the ordered partial-repair states are accounted for: either the save is rejected before any writer call, or an injected index-write failure leaves a loadable/searchable bundle under the cap with its actual hash;
- a later lifecycle repair fixes indexes without changing that hash.

- [x] **Step 2: Run local-memory tests and capture RED**

Run: `bun test packages/local-brain/src/memory/parse.test.ts packages/local-brain/src/memory/provider.test.ts packages/local-brain/src/memory/proposal.test.ts packages/local-brain/src/memory/write.test.ts packages/local-brain/src/local-brain.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/contracts/src/base.test.ts services/context-engine/src/mcp/low-level.test.ts`

Expected: FAIL because search, proposal, save, status, and CLI results still use the single-file shapes.

- [x] **Step 3: Replace the parser and fixture legacy bridge**

Delete `parseMemory`, `LocalMemoryDocument`, the old one-argument parse-error overload, old `writeMemory` fixture helper, the literal `.agents/memory.md` path from public local-memory types, and their exports. Retain only `parseConcept` and deliberate legacy-file rejection tests. Run `rg -n "parseMemory|LocalMemoryDocument|writeMemory\(|baseContentHash|PROJECT_MEMORY_FILE|component-memory\.md|LEGACY_MEMORY_PATH|\.agents/memory\.md" packages/local-brain/src`; every remaining legacy-path hit must be a rejection fixture/test or explanatory message.

- [x] **Step 4: Implement bundle search and ranking**

Cache by canonical project root and `bundleHash`. Flatten `bundle.concepts.flatMap((concept) => concept.chunks)`. Index this text:

```ts
[chunk.type, chunk.title, chunk.description ?? "", chunk.tags.join(" "), chunk.headingPath.join(" "), chunk.content]
  .join("\n");
```

Keep query length `1..2,000` Unicode code points and result limit `1..20`. Request scores for every indexed chunk, sort by score descending, exact lowercased title/heading match descending, then stable chunk ID ascending, and only then slice to limit. Preserve the BM25 score on each result. Map loader/parser errors to stable `LocalBrainError` codes without absolute roots, body text, raw YAML, or queries.

- [x] **Step 5: Implement deterministic OKF proposal rendering**

Use `YAML.stringify(frontmatter, { lineWidth: 0 })` (or the equivalent supported options) and `---` delimiters. Do not invent `generated` or `verified`. Map sections exactly:

```ts
const CATEGORY = {
  Architecture: ["architecture", "Architecture"],
  Conventions: ["conventions", "Convention"],
  Commands: ["commands", "Command"],
  Decisions: ["decisions", "Decision"],
  Warnings: ["warnings", "Warning"],
  Learnings: ["learnings", "Learning"],
} as const;
```

For `file` and `adr` evidence, parse an optional trailing `:<line>` and resolve the repository-relative path from the concept directory; include `#L<line>` when present. Other evidence kinds remain portable `resource` scope descriptors. Preserve `title` and the Wagglebot `kind` extension. Append stable footnote markers to the summary in evidence order.

- [x] **Step 6: Implement conflicts, bundle-bound save, and stale index recovery**

Derive a kebab-case filename using Unicode NFKD, ASCII normalization, and lowercase. Check all concept titles and the target path; exact duplicate yields `no_change`, conflicting target/title yields `needs_resolution`, and never invent a numeric suffix. Replacement must use exact `{ path, contentHash }` and preserve unknown frontmatter keys.

Replacement is category-bound: require the exact selected concept path to be below the directory mapped from the proposal section before rendering. Reject root-level concepts and cross-category replacement requests as `proposal_invalid`; retain the selected path identity for valid same-category replacement.

`LocalMemoryProposal` contains `proposalId`, `baseBundleHash`, `path`, `section`, `title`, `summary`, `evidence`, optional exact `replace`, `action`, complete concept `content`, derived `indexChanges`, unified `patch`, and warnings. The ID hashes canonical JSON containing every submitted field except `proposalId` itself, including proposal-time derived outputs.

At save, first verify `proposalId` against all fields the caller submitted, including proposal-time `indexChanges` and `patch`; this detects a modified proposal before any base-hash comparison. Reload the bundle and compare `baseBundleHash`, which covers authoritative concepts only. Rebuild expected concept content/action from the semantic proposal fields and current concepts, then compare all semantic fields. Do not compare derived `indexChanges` or `patch` against regenerated outputs: regenerate them from the current bundle and return the current intended review patch. Thus a genuine content change causes `memory_changed`, while index-only drift is accepted and repaired without trusting stale derived presentation data. Reject save actions `no_change` (`proposal_invalid`) and `needs_resolution` (`proposal_conflict`) before the writer runs.

Before the first write, simulate the deterministic index repair in write order with the new/replaced concept already durable. Check the total Markdown bytes at every possible failure prefix, including current/stale/obsolete indexes that still exist until their cleanup step, all concepts, logs, and each generated index. Reject with `local_memory_too_large` if any durable partial-repair state could exceed 256 KiB. Then safely create only the fixed category directory under the validated bundle root, atomically write the concept, invalidate search cache, and repair indexes. If concept writing fails after creating a new empty category directory, remove only that newly created empty directory. `patch` in a proposal/save result describes the intended review changes, not proof that every file was written; if `indexes_stale` is present, only the concept write is guaranteed and CLI/MCP must not report the whole patch as applied. Every such state must remain loadable/searchable.

- [x] **Step 7: Adapt `brain remember` to the new public proposal type**

Replace the hand-written proposal shape in `brain-remember.ts` with `LocalMemoryProposal` from `@wagglebot/local-brain`. Print the saved concept path and `newBundleHash`; print every save warning. Add command tests verifying preview does not write, explicit save reports the OKF path/hash, and `warnings: ["indexes_stale"]` is visible without claiming every file in the intended patch was applied. This is part of the core API transition so the package typecheck remains green at this task boundary.

- [x] **Step 8: Migrate the public context and MCP contracts in the same API transition**

In `packages/contracts/src/base.ts`, export `LocalMemoryConceptPathSchema` built on `RelativePathSchema`, and re-export it from `packages/contracts/src/index.ts`. It accepts normalized POSIX concept paths with at least one segment below `.agents/memory/` (including `.agents/memory/component.md`), ending in `.md`, and rejects final basenames `index.md` and `log.md`. Use it for `EvidenceRefSchema`'s `local_memory` path while retaining its ordered-line and lowercase SHA-256 validation. Import it from the package entrypoint in tests to verify the public export; accept `.agents/memory/warnings/retry-writes.md` and `.agents/memory/component.md`; reject `.agents/memory.md`, outside paths, backslashes, traversal, `index.md`, and `log.md`. The proposal input uses this general schema shape for safe paths but separately enforces section/category matching for replacement.

In `services/context-engine/src/mcp/low-level.ts`, change the provider `read()` return type from `LocalMemoryDocument` to `LocalMemoryBundle | undefined`, and consume `LocalMemorySearchResult` directly. The tool returns the exact `hits` and same-snapshot `bundleHash`; it does not perform a second read after search. Replace the proposal Zod schema with a strict mirror of Task 3's complete `LocalMemoryProposal`, including concept `path`/`content`, `baseBundleHash`, `indexChanges`, optional exact `replace: { path, contentHash }`, patch, and warnings. Validate concept/replacement paths and SHA-256 fields at this boundary. Do not add a `@wagglebot/contracts` workspace dependency: `services/context-engine` retains its current dependency set, and its low-level MCP module uses local strict Zod path/hash refinements matching the full `RelativePathSchema` security rules plus `LocalMemoryConceptPathSchema` and `Sha256Schema`; contract and MCP tests use the same positive/negative cases to catch drift. The local-brain save operation remains the authoritative second validation boundary. Accept the same `replace` field in `brain_memory_propose` input. Search's MCP query schema must count Unicode code points exactly like the provider. Keep schema version 1 and do not change CodeGraph/Git shapes or provider isolation. Add assertions for snapshot-consistent hits/hash (including proving no follow-up `read()`), exact OKF hit paths, replacement input, all proposal/save field names, absence of the old single-file/hash names, path security edge cases at both schema boundaries, a supplementary-Unicode query within the code-point limit, and `local_brain_status` carrying the memory path, state, bundle metadata, and independent CodeGraph/Git status.

- [x] **Step 9: Run focused validation**

Run: `bun test packages/local-brain/src/memory/parse.test.ts packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.test.ts packages/local-brain/src/memory/provider.test.ts packages/local-brain/src/memory/proposal.test.ts packages/local-brain/src/memory/write.test.ts packages/local-brain/src/local-brain.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/contracts/src/base.test.ts services/context-engine/src/mcp/low-level.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/index.ts packages/local-brain/src/memory/parse.ts packages/local-brain/src/memory/test-fixture.ts packages/local-brain/src/memory/provider.ts packages/local-brain/src/memory/provider.test.ts packages/local-brain/src/memory/proposal.ts packages/local-brain/src/memory/proposal.test.ts packages/local-brain/src/memory/write.test.ts packages/local-brain/src/local-brain.ts packages/local-brain/src/local-brain.test.ts packages/cli/src/commands/brain-remember.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.ts packages/cli/src/commands/brain-status.test.ts packages/contracts/src/base.ts packages/contracts/src/base.test.ts packages/contracts/src/index.ts services/context-engine/src/mcp/low-level.ts services/context-engine/src/mcp/low-level.test.ts
git commit -m "feat(memory): complete OKF core contract"
```

---

### Task 4: Preserve Ludwig's project lifecycle and teach agents the OKF workflow

**Files:**

- Modify: `packages/cli/src/commands/project-update.ts`
- Modify: `packages/cli/src/commands/project-update.test.ts`
- Modify: `packages/cli/src/commands/project-init.test.ts`
- Modify: `packages/cli/src/commands/brain-init.ts`
- Modify: `packages/cli/src/commands/brain-init.test.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/e2e/sync-project.test.ts`
- Modify: `packages/cli/templates/AGENTS.base.md`
- Delete: `packages/cli/templates/component-memory.md`
- Modify: `skills/onboarding-a-repository/SKILL.md`
- Modify: `packages/cli/e2e/first-party-skills.test.ts`

**Interfaces:**

- Consumes: the single exported `ensureLocalMemoryBundle(root)` lifecycle.
- Produces: `PROJECT_MEMORY_DIR = ".agents/memory"`, consistent CLI output/help, and direct agent/human OKF editing instructions.

**Skill RED evidence already captured before editing:** A fresh Luna xhigh agent read the current onboarding skill and base template and answered that it would read/edit only `.agents/memory.md`, would not create one concept per file, and had no post-edit memory command. It quoted `Do not write outside .agents/memory.md`. This is the failing baseline that the skill edit must correct.

- [ ] **Step 1: Write failing project lifecycle tests**

Change project command tests and E2E assertions to require:

- `project init`, `project update`, and `sync-project` create `.agents/memory/index.md`, `.agents/memory/component.md`, and `.agents/changelog.md` even with zero instruction sources;
- both project commands preserve an existing concept and changelog byte for byte;
- project update repairs a deliberately stale index;
- neither command stages memory, commits it, gitignores it, or creates `catalog-info.yaml`;
- if any instruction target fails read-only preflight (for example, a hard size limit or malformed managed block), project memory/changelog and every harness target remain unchanged;
- `.agents/memory.md` makes the command fail with `local_memory_invalid` before any harness instruction target changes;
- instruction publishing never includes concept or changelog text;
- the hidden alias uses the identical lifecycle.

Update the Git tracked-file E2E assertion to expect the committed paths `.agents/memory/index.md`, `.agents/memory/component.md`, and `.agents/changelog.md`.

- [ ] **Step 2: Write failing brain command and help tests**

Require:

- `brain init` uses the same lifecycle, preserves concepts, repairs indexes, and still initializes CodeGraph plus its owned `.gitignore` block;
- init/update/brain help names only `.agents/memory/` and explains one concept per file;
- no public help names `.agents/memory.md` except a concise rejection/migration-free diagnostic example if tests need it.

- [ ] **Step 3: Write failing template and skill assertions**

In `first-party-skills.test.ts` or the existing template test, assert both guidance files contain:

```text
.agents/memory/index.md
one concept per file
wagglebot update
```

and do not contain `Do not write outside .agents/memory.md` or an instruction to read the entire corpus at session start.

- [ ] **Step 4: Run CLI tests and capture RED**

Run: `bun test packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/first-party-skills.test.ts`

Expected: FAIL on the legacy file paths and guidance.

- [ ] **Step 5: Wire the shared lifecycle into every command**

Remove `ensureProjectFile(..., "component-memory.md")` and its template. `runProjectUpdate` first reads sources/targets and computes and validates every proposed instruction output read-only, including all size and managed-block checks. Only after the entire preflight succeeds does it call `ensureLocalMemoryBundle(root)`, create missing changelog scaffolding, and then mutate instruction targets. Do not return early on an empty instruction plan before the shared lifecycle/changelog calls: zero-source projects still get memory and changelog scaffolding. A preflight failure must not create those files; a legacy memory-file rejection must occur before any instruction target changes. Preserve the current all-target preflight and failure reporting. `runProjectInit` continues creating `.agents/instructions/` and then delegates to `runProjectUpdate`; the alias already delegates to the same function and must remain hidden.

`runBrainInit` calls `ensureLocalMemoryBundle(root)` instead of embedding a template. Keep CodeGraph initialization and `close()` behavior. Do not create a second initializer or a CLI-owned memory template.

- [ ] **Step 6: Rewrite the base agent memory contract**

Keep the existing durable-memory inclusion/exclusion judgment. Replace only the storage/workflow sections with this behavior:

1. Read `.agents/memory/index.md`, then only linked concepts relevant to the task.
2. Direct edits are supported; one durable fact or concept belongs in one non-reserved Markdown file under the matching category.
3. Update an existing concept instead of duplicating it; surface contradictions.
4. An explicit engineer request to remember bypasses importance judgment and writes/updates one concept; a correction removes or fixes it.
5. Run `wagglebot update` to validate and regenerate indexes.
6. Commit concept and index changes so Git and pull requests review them.
7. Cross-repository facts still belong to the future shared layer; never copy them to another local bundle.

Do not instruct agents to hand-edit `index.md`, to read every concept up front, or to invent a memory service.

- [ ] **Step 7: Rewrite the onboarding skill minimally**

Keep its catalog and subagent behavior. Change the overview table and Step 4 to the OKF bundle, progressive reading, one-concept-per-file editing, `wagglebot update`, and Git review. Change the project instruction command from the hidden `wagglebot sync-project` alias to `wagglebot update`. Update common mistakes for gitignored bundles, hand-edited generated indexes, and memory merged into project instructions.

- [ ] **Step 8: Run focused validation**

Run: `bun test packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/first-party-skills.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 9: Run the skill GREEN pressure scenario**

The controller dispatches a fresh `gpt-6-luna` xhigh read-only agent with the updated `skills/onboarding-a-repository/SKILL.md` and `packages/cli/templates/AGENTS.base.md`, using the same scenario as the captured baseline. Passing output must name `.agents/memory/index.md`, one relevant concept file under `.agents/memory/<category>/`, and `wagglebot update`; it must not recommend `.agents/memory.md` or reading the entire bundle. Record the response in the task report.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/commands/project-update.ts packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/help.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/templates/AGENTS.base.md skills/onboarding-a-repository/SKILL.md packages/cli/e2e/first-party-skills.test.ts
git add -u packages/cli/templates/component-memory.md
git commit -m "feat(cli): scaffold OKF component memory"
```

---

### Task 5: Align active documentation and run the release gate

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/phase-1-onboarding.md`
- Modify: `docs/api-reference.md`
- Modify: `docs/superpowers/specs/2026-08-28-wagglebot-design.md`
- Modify: `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md`
- Modify: `docs/superpowers/specs/2026-09-11-local-repository-brain-design.md`
- Modify: `docs/superpowers/specs/2026-09-11-phase-2-memory-roadmap.md`
- Modify: `docs/superpowers/specs/2026-09-11-unified-context-engine-design.md`
- Modify: `docs/superpowers/plans/2026-09-11-local-repository-brain.md`
- Modify: `docs/superpowers/plans/2026-09-11-unified-context-engine.md`
- Modify: `docs/superpowers/plans/2026-09-12-phase-2-implementation-sequence.md`
- Modify only if their generated lifecycle explanation mentions memory: `test-app/README.md`, `packages/cli/templates/init/README.md`

**Interfaces:**

- Consumes: the implemented behavior and the approved design.
- Produces: one consistent active documentation contract and a fully verified branch.

- [ ] **Step 1: Add documentation consistency assertions before prose edits**

Extend an existing lightweight documentation test, preferably `packages/cli/src/help.test.ts`, to read the active user-facing files and assert that project lifecycle docs contain `.agents/memory/`, `one concept`, `wagglebot update`, and Git review language where memory is discussed. Do not assert wording in historical task bodies that are explicitly marked superseded.

- [ ] **Step 2: Run the documentation test and capture RED**

Run: `bun test packages/cli/src/help.test.ts`

Expected: FAIL because README and onboarding text still describe generic memory files or omit the OKF lifecycle.

- [ ] **Step 3: Update active documentation surgically**

Document these exact truths without duplicating the full specification:

- Phase 1 project `init`/`update` automatically scaffold `.agents/memory/index.md`, `.agents/memory/component.md`, and `.agents/changelog.md`.
- Each durable local fact/concept is one Markdown file with YAML frontmatter; `type` is the only required OKF concept key.
- Humans and agents read the root index, edit concepts directly, run `wagglebot update`, and commit the derived indexes for review.
- `brain remember` is preview-first and writes only with `--save`.
- search returns exact concept path/lines and `bundleHash`; indexes/logs are excluded from search/hash.
- project and brain initialization share one lifecycle; no migration or dual-read path exists.
- `.agents/changelog.md` remains separate and unchanged.

Keep explicit supersession banners in the historical local-brain design and plan. Do not rewrite completed history as if the earlier single-file implementation never happened; update their current-contract summaries, paths/interfaces that later plans consume, and gates.

- [ ] **Step 4: Search for stale authoritative references**

Run:

```bash
rg -n "\.agents/memory\.md|baseContentHash|previousContentHash|newContentHash|fileHash|LocalMemoryDocument|parseMemory|PROJECT_MEMORY_FILE|component-memory\.md|LEGACY_MEMORY_PATH" README.md packages services skills test-app docs --glob '!docs/superpowers/plans/2026-09-27-okf-local-memory.md'
```

Every remaining `.agents/memory.md` hit must be one of:

- an explicit historical section marked superseded;
- a rejection/no-migration statement in the OKF design or current docs;
- a regression test proving the removed file is rejected.

Every remaining old hash-name hit must be unrelated shared-memory data or an explicitly superseded historical block. Every remaining parser/type/file-name hit must be explicitly superseded history or a regression test/rejection statement. Fix any active local component-memory contract that still uses them.

The current implementation plan is excluded because its task text intentionally names the old interface in migration/removal steps and rejection tests; its final success conditions still require the new bundle contract. Task 3 separately searches the local-brain source for removed API names.

- [ ] **Step 5: Run focused package tests**

Run:

```bash
bun test packages/local-brain/src packages/contracts/src/base.test.ts services/context-engine/src/mcp/low-level.test.ts packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/first-party-skills.test.ts
```

Expected: PASS with no warnings caused by this change.

- [ ] **Step 6: Run the complete repository gate**

Run each command separately and record its exact summary:

```bash
bun run check
bun run typecheck
bun run build
bun test
git diff --check
git status --short
```

Expected: all checks pass. Existing optional CodeGraph skips are allowed if they remain the only skips. Full tests may create `.wagglebot-auth-e2e-*` directories; inspect each exact directory and remove only those test-created artifacts. Leave `.idea/` untouched.

- [ ] **Step 7: Inspect the final diff**

Confirm:

- no dependency or lockfile changed;
- no unrelated file was reformatted;
- no runtime path reads or writes `.agents/memory.md`;
- no concept command stages or commits user files;
- no debug output, temporary file, absolute local path, or secret was introduced;
- implementation matches every acceptance criterion in the spec.

- [ ] **Step 8: Commit**

```bash
git add README.md packages/cli/README.md docs/phase-1-onboarding.md docs/api-reference.md docs/superpowers/specs/2026-08-28-wagglebot-design.md docs/superpowers/specs/2026-08-28-phase-1-provisioning.md docs/superpowers/specs/2026-09-11-local-repository-brain-design.md docs/superpowers/specs/2026-09-11-phase-2-memory-roadmap.md docs/superpowers/specs/2026-09-11-unified-context-engine-design.md docs/superpowers/plans/2026-09-11-local-repository-brain.md docs/superpowers/plans/2026-09-11-unified-context-engine.md docs/superpowers/plans/2026-09-12-phase-2-implementation-sequence.md packages/cli/src/help.test.ts
git add test-app/README.md packages/cli/templates/init/README.md
git commit -m "docs(memory): document the OKF workflow"
```

The implementation subagent must omit unchanged optional files from the commit rather than creating empty changes.

---

## Final Success Conditions

The plan is complete only when all of these are directly verified:

1. A new Git repository gets one conformant draft component concept and root index from project `init`, project `update`, or `brain init` through the same implementation.
2. Existing concept and changelog bytes survive repeated lifecycle commands; only stale/missing derived indexes are repaired.
3. Human concepts with only `type` are accepted, while malformed YAML, missing type, oversize bundles, legacy files, and symlinks fail with stable safe errors.
4. Search spans multiple concepts, excludes reserved files, and returns exact concept paths and line provenance.
5. Proposal/save covers add, duplicate, conflict, exact replacement, tamper, concurrent concept change, index-only change, secret rejection, atomic failure, and stale-index recovery.
6. CLI, MCP, contracts, templates, skills, fixtures, plans, and user docs use OKF paths and bundle hashes consistently.
7. A fresh Luna agent follows the updated index-first, one-concept-per-file, `wagglebot update`, Git-review workflow.
8. Formatting, type checking, build, full tests, diff check, and final diff inspection are clean apart from the known optional CodeGraph skips and untouched `.idea/`.
