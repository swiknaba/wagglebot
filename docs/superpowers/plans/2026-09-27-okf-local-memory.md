# OKF Local Component Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `.agents/memory.md` implementation with a conformant, committed OKF v0.2 bundle whose concepts are individually readable and editable, while preserving Ludwig's automatic project scaffolding and agent-owned Git-review workflow.

**Architecture:** `@wagglebot/local-brain` owns one shared bundle lifecycle used by project `init`, project `update`, the hidden `sync-project` alias, and `brain init`. Focused modules parse concepts, load bounded bundles, render derived indexes, search authoritative concepts, and propose/save one concept atomically; the CLI and MCP layers only adapt those interfaces. The removed file is rejected, never migrated or read.

**Tech Stack:** TypeScript 5.9.2, Bun, Node.js filesystem APIs, YAML 2.8.3, Zod 4.6.1, the existing in-process BM25 implementation, the existing secret scanner, Biome 2.2.0.

**Spec:** `docs/superpowers/specs/2026-09-26-okf-local-memory-design.md`

## Global Constraints

- Every implementation and fix subagent for this plan uses `gpt-6-luna` with reasoning effort `xhigh`, as requested. A fresh subagent implements each task; subagents never dispatch their own subagents.
- Follow test-driven development: add the named behavioral tests, run them and capture the expected failure, then implement the minimum behavior and re-run the same command.
- `.agents/memory/` is the only supported component-memory location. If `.agents/memory.md` exists, fail with `local_memory_invalid`; never read, migrate, copy, rename, overwrite, or delete it.
- OKF v0.2 requires only a parseable YAML frontmatter mapping with a non-empty string `type`. Accept unknown types, unknown frontmatter keys, missing optional fields, and broken Markdown links.
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

- [ ] **Step 1: Replace parser tests with OKF conformance tests**

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

- [ ] **Step 2: Run the parser tests and capture RED**

Run: `bun test packages/local-brain/src/memory/parse.test.ts`

Expected: FAIL because `parseConcept`, `LocalMemoryPath`, and OKF frontmatter parsing do not exist.

- [ ] **Step 3: Implement the types and parser**

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

- [ ] **Step 4: Run focused validation**

Run: `bun test packages/local-brain/src/memory/parse.test.ts && bun run check && bun run typecheck`

Expected: parser tests pass, Biome is clean, and TypeScript passes because the
existing single-file interfaces remain temporarily available to unchanged
callers.

- [ ] **Step 5: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/memory/parse.ts packages/local-brain/src/memory/parse.test.ts packages/local-brain/src/memory/test-fixture.ts packages/local-brain/src/index.ts
git commit -m "feat(memory): parse OKF concepts"
```

---

### Task 2: Load bundles, render indexes, and share one lifecycle

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
export const LEGACY_MEMORY_PATH = ".agents/memory.md" as const;

export function loadMemoryBundle(projectRoot: string): LocalMemoryBundle | undefined;
export function renderMemoryIndexes(concepts: LocalMemoryConcept[]): Map<LocalMemoryPath, string>;
export function repairMemoryIndexes(
  projectRoot: string,
  bundle: LocalMemoryBundle,
  write?: (target: string, content: string) => void,
): LocalMemoryBundle;
export function ensureLocalMemoryBundle(projectRoot: string): LocalMemoryBundle;
```

- [ ] **Step 1: Write failing bundle-loader tests**

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
- a root `index.md` with malformed YAML or a declared version other than string `"0.2"` is invalid; a category index with frontmatter is invalid.

- [ ] **Step 2: Write failing deterministic-index tests**

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

- [ ] **Step 3: Write failing lifecycle tests**

In `lifecycle.test.ts`, assert:

```ts
const bundle = ensureLocalMemoryBundle(repo);
expect(bundle.path).toBe(".agents/memory");
expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).toContain('okf_version: "0.2"');
expect(readFileSync(join(repo, ".agents/memory/component.md"), "utf8")).toContain("type: Component Overview");
expect(readFileSync(join(repo, ".agents/memory/component.md"), "utf8")).toContain("status: draft");
```

Run twice and prove component bytes are unchanged. Add a human concept and a valid `log.md`, corrupt an index, run again, and prove only the index changed. Create `.agents/memory.md`, then prove the command throws before creating `.agents/memory/`.

- [ ] **Step 4: Run all new tests and capture RED**

Run: `bun test packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.test.ts`

Expected: FAIL because the three modules and public interfaces do not exist.

- [ ] **Step 5: Implement bounded traversal and reserved-file validation**

Use `lstatSync`/`readdirSync({ withFileTypes: true })` and never call a traversal API that follows a discovered symlink. Resolve the repository and bundle roots once; reject any discovered symbolic link before reading it. Normalize all public paths to POSIX separators.

Count bytes while reading each `.md` file and stop with `local_memory_too_large` as soon as the running total exceeds `256 * 1024`. Ignore non-Markdown regular files for this v1 consumer. Validate reserved files without treating their content as concepts. Sort concepts, indexes, and logs before returning.

Compute:

```ts
const bundleHash = sha256(
  concepts.map((concept) => `${concept.relativePath}\0${concept.contentHash}`).sort().join("\0"),
);
```

An empty existing bundle uses the SHA-256 of the empty string. It is valid but does not receive a component concept; only a wholly missing bundle gets the initial component.

- [ ] **Step 6: Implement deterministic indexes and repair**

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

- [ ] **Step 7: Implement the shared initializer**

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

- [ ] **Step 8: Run focused validation**

Run: `bun test packages/local-brain/src/memory/parse.test.ts packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.test.ts && bun run check && bun run typecheck`

Expected: all focused tests, formatting, and types pass.

- [ ] **Step 9: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/index.ts packages/local-brain/src/memory/bundle.ts packages/local-brain/src/memory/bundle.test.ts packages/local-brain/src/memory/indexes.ts packages/local-brain/src/memory/indexes.test.ts packages/local-brain/src/memory/lifecycle.ts packages/local-brain/src/memory/lifecycle.test.ts packages/local-brain/src/memory/write.ts
git commit -m "feat(memory): load and initialize OKF bundles"
```

---

### Task 3: Search OKF concepts and report bundle status

**Files:**

- Replace: `packages/local-brain/src/memory/provider.ts`
- Replace: `packages/local-brain/src/memory/provider.test.ts`
- Modify: `packages/local-brain/src/memory/parse.ts`
- Modify: `packages/local-brain/src/memory/test-fixture.ts`
- Modify: `packages/local-brain/src/index.ts`
- Modify: `packages/local-brain/src/local-brain.ts`
- Modify: `packages/local-brain/src/local-brain.test.ts`
- Modify: `packages/local-brain/src/types.ts`

**Interfaces:**

- Consumes: `loadMemoryBundle` and the existing `Bm25Index`.
- Produces `MarkdownMemoryProvider.read(): Promise<LocalMemoryBundle | undefined>` and this status shape:

```ts
export type LocalBrainStatus = {
  project: ProjectIdentity;
  memory: {
    state: "missing" | "ready" | "error";
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

- [ ] **Step 1: Write failing search tests**

Replace the provider fixtures with at least three concepts in different directories. Assert:

- search returns exact paths such as `.agents/memory/architecture/token-service.md`;
- a query can match type, title, description, tags, heading text, or body text;
- returned `content`, `startLine`, `endLine`, and `contentHash` come from the authoritative concept chunk;
- exact title or heading matches sort ahead when BM25 scores otherwise compete;
- indexes and `log.md` never become hits;
- changing one concept invalidates the cache because `bundleHash` changes;
- changing only an index does not invalidate authoritative search results;
- a missing bundle returns `[]`;
- a legacy file, malformed concept, oversize bundle, or symlink fails with its documented stable error code.

- [ ] **Step 2: Update status tests**

Make the fake memory provider return:

```ts
{
  bundleHash: "a".repeat(64),
  concepts: [{}, {}],
  totalBytes: 512,
  indexState: "stale",
}
```

Assert the healthy memory status exposes `bundleHash`, `conceptCount: 2`, `totalBytes: 512`, and `indexState: "stale"`, while an independent CodeGraph failure still leaves memory ready.

- [ ] **Step 3: Run focused tests and capture RED**

Run: `bun test packages/local-brain/src/memory/provider.test.ts packages/local-brain/src/local-brain.test.ts`

Expected: FAIL because the provider still reads and indexes one file and status still uses `contentHash`.

- [ ] **Step 4: Implement bundle search and cache behavior**

Cache by canonical project root plus `bundleHash`. Flatten `bundle.concepts.flatMap((concept) => concept.chunks)`. Feed BM25 this searchable string:

```ts
[chunk.type, chunk.title, chunk.description ?? "", chunk.tags.join(" "), chunk.headingPath.join(" "), chunk.content]
  .join("\n");
```

Keep the current query bound `1..2,000` code points and limit `1..20`. Exact lowercased title or heading equality is only a deterministic tie-break; retain the BM25 score returned to callers. Map loader/parser failures to their documented `LocalBrainError` codes without exposing bodies or absolute paths.

- [ ] **Step 5: Implement bundle status**

Change the local-brain memory provider constraint from `{ contentHash }` to `{ bundleHash, concepts, totalBytes, indexState }`. Keep provider isolation via `Promise.allSettled`. Do not let an invalid memory bundle make CodeGraph or Git unavailable.

In this same step, delete the now-unused `parseMemory`,
`LocalMemoryDocument`, single-file fixture helpers, legacy type fields, and
their exports. Run `rg -n "parseMemory|LocalMemoryDocument|writeMemory\(|baseContentHash|\.agents/memory\.md" packages/local-brain/src` and require that only deliberate rejection tests mention the removed path.

- [ ] **Step 6: Run focused validation**

Run: `bun test packages/local-brain/src/memory/provider.test.ts packages/local-brain/src/local-brain.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/index.ts packages/local-brain/src/memory/parse.ts packages/local-brain/src/memory/test-fixture.ts packages/local-brain/src/memory/provider.ts packages/local-brain/src/memory/provider.test.ts packages/local-brain/src/local-brain.ts packages/local-brain/src/local-brain.test.ts
git commit -m "feat(memory): search OKF concept bundles"
```

---

### Task 4: Propose and atomically save one concept

**Files:**

- Replace: `packages/local-brain/src/memory/proposal.ts`
- Replace: `packages/local-brain/src/memory/proposal.test.ts`
- Replace: `packages/local-brain/src/memory/write.test.ts`
- Modify: `packages/local-brain/src/memory/provider.ts`
- Modify: `packages/local-brain/src/types.ts`
- Modify: `packages/local-brain/src/index.ts`

**Interfaces:**

- Consumes: loaded bundles, deterministic index rendering, `assertSafeText`, and atomic writes.
- Produces these exact wire-oriented types:

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

- [ ] **Step 1: Write failing proposal tests**

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

For title `Retries can duplicate a charge`, assert target `.agents/memory/warnings/retries-can-duplicate-a-charge.md`, `status: stable`, tag `[warning]`, stable `evidence-1`, and this semantic body:

```md
# Warning

Do not retry a timed-out charge until its idempotency record is checked.[^evidence-1]

[^evidence-1]: `src/payments/charge.ts:74`
```

The source frontmatter entry for file evidence is exactly:

```yaml
- id: evidence-1
  resource: ../../../src/payments/charge.ts#L74
  title: src/payments/charge.ts:74
  kind: file
```

Also assert:

- NFKD normalization yields lowercase ASCII kebab-case and an empty resulting slug is `proposal_invalid`;
- 1..80 title, 1..1,000 one-line summary, 1..20 evidence, safe relative refs, and existing transcript/unknown-field rejection remain enforced;
- no file is written during proposal;
- generated root/category `indexChanges` and the unified patch are deterministic and sorted by path;
- exact duplicate is `no_change` with an empty patch;
- an existing target or case-insensitive same title anywhere in the bundle is `needs_resolution`;
- no numeric suffix is ever selected;
- replace succeeds only for the exact concept `path` and `contentHash`;
- replace keeps producer extensions plus `resource`, `generated`, `verified`, and `stale_after`, while replacing `type`, `title`, `description`, `tags`, `status`, `sources`, and body;
- proposal JSON contains no transcript or absolute root.

- [ ] **Step 2: Write failing save tests**

Assert:

- concurrent concept addition/change causes `memory_changed` through `baseBundleHash`;
- changing only a derived index after proposal does not cause `memory_changed`;
- tampering with `proposalId`, `path`, `content`, `indexChanges`, `patch`, action, or evidence causes `proposal_invalid`;
- a final-content secret is rejected before the writer runs;
- successful add writes exactly one concept plus affected indexes, returns previous/new bundle hashes, and never stages or commits;
- successful replace writes only the selected concept identity, not a new slug;
- a concept-write failure leaves all original files intact;
- an index-write failure after the concept returns `warnings: ["indexes_stale"]`, leaves the new concept readable/searchable, and reports the actual new bundle hash;
- a later `ensureLocalMemoryBundle` repairs those indexes without changing the new bundle hash.

- [ ] **Step 3: Run proposal/save tests and capture RED**

Run: `bun test packages/local-brain/src/memory/proposal.test.ts packages/local-brain/src/memory/write.test.ts`

Expected: FAIL because proposals still append an H3 entry to one file and use `baseContentHash`.

- [ ] **Step 4: Implement deterministic concept rendering**

Use `YAML.stringify(frontmatter, { lineWidth: 0 })` or its typed equivalent and delimit it with `---`. Do not write `generated` or `verified` for a new concept. Append every evidence footnote marker to the single summary paragraph in input order.

For `file` and `adr`, convert `path:line` to a path relative from the concept directory and a `#L<line>` fragment. For `commit`, `issue`, `test`, and `maintainer_confirmation`, keep the validated ref as a portable `resource` scope descriptor. `title` remains the original ref and `kind` remains the Wagglebot extension.

- [ ] **Step 5: Implement conflict detection and patches**

Search all concepts for same-title conflicts. When `replace` is present, find that exact path and hash before rendering with its preserved frontmatter. Proposal IDs hash a canonical JSON object containing schema version 1 plus every field that can affect save: base bundle hash, path, replacement target, action, section, title, summary, evidence, complete content, index changes, and patch.

The multi-file unified patch uses `--- /dev/null` for a new concept, `--- a/<path>` for replacements, `+++ b/<path>` for every changed file, and one whole-file hunk per changed file. Sort every changed file together by repository-relative path.

- [ ] **Step 6: Implement save verification and write ordering**

Reload the bundle and compare `baseBundleHash`. Rebuild the proposal from its declared inputs and replacement target. Compare all save-relevant fields, not only `proposalId`. Scan `expected.content`, write the concept atomically, invalidate the provider cache, then call index repair.

Catch only index repair failure after the concept write and return `indexes_stale`. Do not report that the proposal patch was wholly applied when indexes are stale; the returned `patch` remains the proposal's review patch and `warnings` carries the partial-derived-state signal.

- [ ] **Step 7: Run focused validation**

Run: `bun test packages/local-brain/src/memory/proposal.test.ts packages/local-brain/src/memory/write.test.ts packages/local-brain/src/memory/provider.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/local-brain/src/types.ts packages/local-brain/src/index.ts packages/local-brain/src/memory/proposal.ts packages/local-brain/src/memory/proposal.test.ts packages/local-brain/src/memory/provider.ts packages/local-brain/src/memory/write.test.ts
git commit -m "feat(memory): propose and save OKF concepts"
```

---

### Task 5: Preserve Ludwig's project lifecycle and teach agents the OKF workflow

**Files:**

- Modify: `packages/cli/src/commands/project-update.ts`
- Modify: `packages/cli/src/commands/project-update.test.ts`
- Modify: `packages/cli/src/commands/project-init.test.ts`
- Modify: `packages/cli/src/commands/brain-init.ts`
- Modify: `packages/cli/src/commands/brain-init.test.ts`
- Modify: `packages/cli/src/commands/brain-remember.ts`
- Modify: `packages/cli/src/commands/brain-remember.test.ts`
- Modify: `packages/cli/src/commands/brain-status.ts`
- Modify: `packages/cli/src/commands/brain-status.test.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/e2e/sync-project.test.ts`
- Modify: `packages/cli/templates/AGENTS.base.md`
- Delete: `packages/cli/templates/component-memory.md`
- Modify: `skills/onboarding-a-repository/SKILL.md`
- Modify: `packages/cli/e2e/first-party-skills.test.ts`

**Interfaces:**

- Consumes: the single exported `ensureLocalMemoryBundle(root)` lifecycle and the Task 4 proposal/save types.
- Produces: `PROJECT_MEMORY_DIR = ".agents/memory"`, consistent CLI output/help, and direct agent/human OKF editing instructions.

**Skill RED evidence already captured before editing:** A fresh Luna xhigh agent read the current onboarding skill and base template and answered that it would read/edit only `.agents/memory.md`, would not create one concept per file, and had no post-edit memory command. It quoted `Do not write outside .agents/memory.md`. This is the failing baseline that the skill edit must correct.

- [ ] **Step 1: Write failing project lifecycle tests**

Change project command tests and E2E assertions to require:

- `project init`, `project update`, and `sync-project` create `.agents/memory/index.md`, `.agents/memory/component.md`, and `.agents/changelog.md` even with zero instruction sources;
- both project commands preserve an existing concept and changelog byte for byte;
- project update repairs a deliberately stale index;
- neither command stages memory, commits it, gitignores it, or creates `catalog-info.yaml`;
- `.agents/memory.md` makes the command fail with `local_memory_invalid` before any harness instruction target changes;
- instruction publishing never includes concept or changelog text;
- the hidden alias uses the identical lifecycle.

Update the Git tracked-file E2E assertion to expect the committed paths `.agents/memory/index.md`, `.agents/memory/component.md`, and `.agents/changelog.md`.

- [ ] **Step 2: Write failing brain command and help tests**

Require:

- `brain init` uses the same lifecycle, preserves concepts, repairs indexes, and still initializes CodeGraph plus its owned `.gitignore` block;
- `brain remember` prints and saves the exact proposal `path`, then prints `new bundle hash` and any `indexes_stale` warning;
- `brain status` text contains `.agents/memory/`, concept count, bundle hash, and index state;
- typed JSON uses the Task 3 status shape;
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

Run: `bun test packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/first-party-skills.test.ts`

Expected: FAIL on the legacy file paths and guidance.

- [ ] **Step 5: Wire the shared lifecycle into every command**

Remove `ensureProjectFile(..., "component-memory.md")` and its template. `runProjectUpdate` calls `ensureLocalMemoryBundle(root)` before changelog creation or instruction-target mutation. It retains the current all-target instruction preflight and failure reporting. `runProjectInit` continues creating `.agents/instructions/` and then delegates to `runProjectUpdate`; the alias already delegates to the same function and must remain hidden.

`runBrainInit` calls `ensureLocalMemoryBundle(root)` instead of embedding a template. Keep CodeGraph initialization and `close()` behavior. Do not create a second initializer or a CLI-owned memory template.

Update remember/status output to the exact Task 4 and Task 3 names. Do not retain `baseContentHash`, `previousContentHash`, `newContentHash`, or `fileHash` aliases.

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

Run: `bun test packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/first-party-skills.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 9: Run the skill GREEN pressure scenario**

The controller dispatches a fresh `gpt-6-luna` xhigh read-only agent with the updated `skills/onboarding-a-repository/SKILL.md` and `packages/cli/templates/AGENTS.base.md`, using the same scenario as the captured baseline. Passing output must name `.agents/memory/index.md`, one relevant concept file under `.agents/memory/<category>/`, and `wagglebot update`; it must not recommend `.agents/memory.md` or reading the entire bundle. Record the response in the task report.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/commands/project-update.ts packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/commands/brain-init.ts packages/cli/src/commands/brain-init.test.ts packages/cli/src/commands/brain-remember.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.ts packages/cli/src/commands/brain-status.test.ts packages/cli/src/help.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/templates/AGENTS.base.md skills/onboarding-a-repository/SKILL.md packages/cli/e2e/first-party-skills.test.ts
git add -u packages/cli/templates/component-memory.md
git commit -m "feat(cli): scaffold OKF component memory"
```

---

### Task 6: Update local MCP and context evidence contracts

**Files:**

- Modify: `packages/contracts/src/base.ts`
- Modify: `packages/contracts/src/base.test.ts`
- Modify: `services/context-engine/src/mcp/low-level.ts`
- Modify: `services/context-engine/src/mcp/low-level.test.ts`

**Interfaces:**

- Consumes: Task 4 proposal/save types and Task 3 bundles/status.
- Produces schema version 1 with the first supported OKF shapes; no compatibility union is allowed.

- [ ] **Step 1: Write failing evidence-contract tests**

Accept:

```ts
{
  kind: "local_memory",
  path: ".agents/memory/warnings/retry-writes.md",
  startLine: 8,
  endLine: 8,
  contentHash: "a".repeat(64),
}
```

Reject `.agents/memory.md`, paths outside `.agents/memory/`, backslashes, traversal, `index.md`, and `log.md`. Preserve the current ordered positive line and lowercase SHA-256 checks.

- [ ] **Step 2: Write failing low-level MCP tests**

Require `local_memory_search` to return:

```ts
{
  schemaVersion: 1,
  hits: [
    {
      id: "chunk",
      path: ".agents/memory/warnings/retry-writes.md",
      type: "Warning",
      title: "Retries can duplicate a charge",
      tags: ["warning"],
      headingPath: ["Warning"],
      content: "Reconcile before retrying.",
      score: 1,
      startLine: 8,
      endLine: 8,
      contentHash: "b".repeat(64),
    },
  ],
  bundleHash: "a".repeat(64),
}
```

Require propose input to accept optional `replace: { path, contentHash }`; proposal schema must require `baseBundleHash`, `path`, `content`, and `indexChanges`; save output must use `previousBundleHash`, `newBundleHash`, and `warnings`. Assert old names `fileHash`, `baseContentHash`, `previousContentHash`, and `newContentHash` are absent.

- [ ] **Step 3: Run contract tests and capture RED**

Run: `bun test packages/contracts/src/base.test.ts services/context-engine/src/mcp/low-level.test.ts`

Expected: FAIL on the literal legacy path and old proposal/hash schemas.

- [ ] **Step 4: Implement the bounded local concept path schema**

Build on `RelativePathSchema`. Refine that the path starts with `.agents/memory/`, ends in `.md`, has at least one segment below the memory root, and has a final basename other than `index.md` or `log.md`. Export it as `LocalMemoryConceptPathSchema` for later unified-context work and use it in `EvidenceRefSchema`.

- [ ] **Step 5: Replace MCP schemas and response names**

Mirror the Task 4 types exactly in strict Zod schemas. Use `Sha256Schema` for all content/bundle hashes and `LocalMemoryConceptPathSchema` for concept and replacement paths. `local_memory_search` reads `bundle.bundleHash`, not an alias. Keep schema version 1 because no supported public consumer shipped.

Do not change CodeGraph or Git tool shapes. Keep strict unknown-field rejection, result formatting, and provider independence.

- [ ] **Step 6: Run focused validation**

Run: `bun test packages/contracts/src/base.test.ts services/context-engine/src/mcp/low-level.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/base.ts packages/contracts/src/base.test.ts services/context-engine/src/mcp/low-level.ts services/context-engine/src/mcp/low-level.test.ts
git commit -m "feat(context): expose OKF memory contracts"
```

---

### Task 7: Align active documentation and run the release gate

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
rg -n "\.agents/memory\.md|baseContentHash|previousContentHash|newContentHash|fileHash" README.md packages services skills test-app docs
```

Every remaining `.agents/memory.md` hit must be one of:

- an explicit historical section marked superseded;
- a rejection/no-migration statement in the OKF design or current docs;
- a regression test proving the removed file is rejected.

Every remaining old hash-name hit must be unrelated shared-memory data or an explicitly superseded historical block. Fix any active local component-memory contract that still uses it.

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
