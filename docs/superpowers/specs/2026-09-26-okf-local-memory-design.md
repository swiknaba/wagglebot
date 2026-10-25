# OKF Local Component Memory Design

**Status:** Approved architecture

> **Supersedes:** The single-file component-memory portions of
> [Local Repository Brain Design](2026-09-11-local-repository-brain-design.md),
> [Phase 2 Memory Roadmap](2026-09-11-phase-2-memory-roadmap.md), and D29 in
> [Wagglebot Design](2026-08-28-wagglebot-design.md), plus the single-file
> project-memory portions of
> [Phase 1 Polish](2026-09-21-phase-1-polish-design.md).
> **Standard:** [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
> **Reference bundle:** [Acme Retail](https://github.com/GoogleCloudPlatform/open-knowledge-format/tree/main/bundles/acme_retail)

## Decision

Repository-local component memory is an Open Knowledge Format (OKF) v0.2
bundle under `.agents/memory/`. Each durable memory or concept is one Markdown
file with YAML frontmatter. The bundle is committed and reviewed with the code
it describes.

Phase 1 v0.3.0 shipped Ludwig's project lifecycle idea: `wagglebot init` and
`wagglebot update` create committed component memory, and generated agent
instructions teach agents to maintain it. This design keeps that behavior and
changes the representation from one `.agents/memory.md` file to the OKF bundle.

The Repository Brain has not shipped a supported consumer of the single-file
format, and the project has no live memory data that needs conversion.
`.agents/memory.md` is therefore removed without a legacy reader, migration
command, dual-write path, or compatibility alias.

The change affects local component memory only. Shared system, domain, and
organization memory remains in the shared-memory service.

## Goals

1. Make every memory independently readable, reviewable, linkable, and
   replaceable.
2. Produce a conformant OKF v0.2 bundle that ordinary Markdown and YAML tools
   can consume without Wagglebot.
3. Preserve explicit proposal and save semantics, local secret scanning,
   optimistic concurrency, atomic concept writes, and Git review.
4. Let humans and agents discover the corpus progressively through generated
   `index.md` files.
5. Keep retrieval local and deterministic through in-process BM25.
6. Preserve repository-relative evidence without storing prompts, transcripts,
   session state, or hidden reasoning.
7. Preserve the Phase 1 lifecycle: project initialization and update create the
   committed memory structure, never overwrite human concepts, and teach every
   provisioned agent how to read and edit it through ordinary files and Git.

## Non-Goals

- Supporting or migrating `.agents/memory.md`; no live data needs migration in
  this first supported version.
- Defining a new knowledge standard or adding Wagglebot-only required
  frontmatter.
- Adding a local database, vector index, file watcher, or background service.
- Automatically creating memories from chats, source files, or Git history.
- Implementing OKF attested computations, receipts, or attesters.
- Maintaining `log.md`; Git already supplies component-memory history.
- Uploading the bundle or its repository-relative sources to a shared service.

## Bundle Layout

```text
.agents/
├── instructions/
├── changelog.md
└── memory/
    ├── index.md
    ├── component.md
    ├── architecture/
    │   ├── index.md
    │   └── module-boundaries.md
    ├── conventions/
    │   ├── index.md
    │   └── error-codes.md
    ├── commands/
    ├── decisions/
    ├── warnings/
    └── learnings/
```

The directory names retain the existing proposal categories and follow the
reference bundles' pattern of grouping concepts by semantic type. The root
`component.md` is a `Component Overview`; every proposed memory goes into the
lowercase directory for its category. Directories are created only when they
contain a concept, so the committed bundle never relies on empty directories.

The root `index.md` declares `okf_version: "0.2"` and links to `component.md`
and each populated category's `index.md`. Each index groups direct children by
`type`, sorts them by case-insensitive `title`, and includes `description`,
matching the canonical reference indexer. Known category directories use fixed
descriptions; Wagglebot never calls a model to summarize a directory. Index
files are deterministic derived views. Search scans concept documents directly
and does not treat indexes as knowledge.

The root is a compact table of contents:

```markdown
---
okf_version: "0.2"
---

# Component Memory

- [Component overview](component.md): Repository purpose, boundaries, and ownership.
- [Architecture](architecture/index.md): Durable structural constraints and boundaries.
- [Warnings](warnings/index.md): Traps, hazards, and costly failure modes.
```

A category index is plain Markdown with no frontmatter:

```markdown
# Warnings

Traps, hazards, and costly failure modes.

## Warning

- [Retries can duplicate a charge](retries-can-duplicate-a-charge.md): A timed-out charge must be reconciled before another write.
```

If a human-authored concept omits the optional `title`, the index uses its file
stem as the link label. If it omits `description`, the index omits the colon and
description. Concept identity is the bundle-relative path without `.md`; title
changes therefore do not change identity unless a caller explicitly renames the
file.

Wagglebot does not create or update `log.md`. OKF makes it optional, and Git
already provides chronological, attributed history for this repository-scoped
bundle. If a human adds a conformant root `log.md`, the provider preserves it,
counts it toward the bundle-size limit, and excludes it from search, indexes,
and the authoritative `bundleHash`.

## Concept Documents

Every non-reserved Markdown file is a conformant OKF concept:

```markdown
---
type: Warning
title: Retries can duplicate a charge
description: A timed-out charge must be reconciled before another write.
tags: [warning]
status: stable
sources:
  - id: evidence-1
    resource: ../../../src/payments/charge.ts#L81
    title: src/payments/charge.ts:81
    kind: file
---

# Warning

A timed-out charge must be reconciled before another write.[^evidence-1]

[^evidence-1]: `src/payments/charge.ts:81`
```

Wagglebot-generated proposal concepts use these fields:

- `type`: the proposal section mapped to its singular concept type
  (`Architecture → Architecture`, `Conventions → Convention`,
  `Commands → Command`, `Decisions → Decision`, `Warnings → Warning`, and
  `Learnings → Learning`); the initializer separately writes
  `type: Component Overview` in `component.md`;
- `title`: the proposal title;
- `description`: the proposal summary;
- `tags`: the lowercase concept type;
- `status`: `stable`, because a concept is written only after an explicit save;
- `sources`: one entry per proposal evidence item.

`sources[].kind` is an allowed OKF extension that preserves Wagglebot's existing
evidence classification. Repository file and ADR references become relative
paths from the concept document. Commit, issue, test, and maintainer references
remain portable scope descriptors. Stable `evidence-N` IDs join sources to
Markdown footnotes in the body, following OKF's claim-attribution convention.

Wagglebot does not write `generated` or `verified`. The local-brain process
serializes content supplied by a caller but does not know whether a human,
agent, or deterministic process authored or verified the claim. Inventing an
actor would make OKF trust metadata misleading. A human or agent that knows the
actor may add conformant `generated`, `verified`, `stale_after`, cross-links,
or producer extensions manually; Wagglebot preserves those fields when it
round-trips a concept. Preservation applies to field values, not byte-for-byte
YAML formatting or comments.

The generated body uses one semantic H1 matching the concept type (`#
Decision`, `# Warning`, and so on), followed by the concise claim and its keyed
evidence footnotes. This mirrors the reference bundles' use of structured,
domain-specific headings rather than repeating the display title as body text.

Human-authored concepts need only the OKF-required non-empty `type`. The parser
accepts unknown types, unknown frontmatter keys, missing optional fields, and
broken links as required by OKF. A concept is invalid only when its Markdown is
not UTF-8 text, its YAML frontmatter is malformed, or `type` is missing or
empty. Reserved `index.md` and `log.md` files are parsed separately.

The complete bundle remains capped at 256 KiB, preserving the existing local
memory bound. Search chunks remain capped at 4,000 Unicode code points.

## Parsing and Retrieval

The provider recursively enumerates `.md` files under `.agents/memory/` without
following symbolic links. It rejects a resolved path outside the bundle,
malformed concept frontmatter, duplicate concept paths, invalid reserved files,
or a bundle over 256 KiB.

Each concept produces chunks from its type, title, description, tags, heading
ancestry, and body. A long body is split at paragraph or sentence boundaries.
Every chunk records:

```typescript
type LocalMemoryChunk = {
  id: string;
  path: `.agents/memory/${string}.md`;
  type: string;
  title: string;
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};
```

The chunk ID hashes the concept path, heading path, and ordinal. BM25 indexes
`type`, `title`, `description`, tags, headings, and body text. Exact title or
heading matches remain the deterministic tie-break. Results return the exact
concept path and lines; generated indexes are never search hits.

`LocalMemoryBundle.bundleHash` hashes the sorted `(relative path, file hash)`
pairs for authoritative concept files only. Derived indexes are excluded, so
repairing a stale index does not invalidate an otherwise current proposal. This
is the optimistic-concurrency token for a proposal.

## Proposal and Save

The public proposal categories remain:

```typescript
type LocalMemorySection =
  | "Architecture"
  | "Conventions"
  | "Commands"
  | "Decisions"
  | "Warnings"
  | "Learnings";
```

`brain_memory_propose` validates and secret-scans the finished title, concise
single-paragraph summary, and evidence, then derives a lowercase ASCII
kebab-case filename from the title. An empty slug is invalid. The target is
`.agents/memory/<section>/<slug>.md`.

- No target file and no same-title concept: `add`.
- Identical existing concept: `no_change`.
- Existing target or same-title concept with different content:
  `needs_resolution`.
- An exact `replace.path` and `replace.contentHash` match: `replace`.

The provider never adds a numeric suffix or guesses which concept to replace.
The proposal contains `baseBundleHash`, `path`, the complete concept text, the
index changes, and one multi-file unified patch. Proposal IDs hash all those
fields.

`brain_memory_save` rebuilds the proposal against the current bundle and
rejects a changed bundle, tampered proposal, conflict, or secret. It writes the
concept atomically, then atomically regenerates affected category and root
indexes. Indexes are derived: if index regeneration fails after the concept is
durable, the save result reports an `indexes_stale` warning rather than
claiming the whole patch was applied. A later save or `brain init` repairs
indexes from concept frontmatter. Search and status remain read-only and use
concept documents as the authority. Replacement preserves unknown frontmatter
keys and optional OKF trust/freshness fields while replacing the title,
description, type, status, sources, tags, and body named by the proposal. The
command never stages or commits files.

## Initialization and CLI

A shared `ensureLocalMemoryBundle(root)` lifecycle operation is the only code
path that initializes or repairs component memory. `wagglebot init`,
`wagglebot update`, the hidden `sync-project` alias, and `wagglebot brain init`
all call it so Phase 1 scaffolding and the Repository Brain cannot drift.

The lifecycle operation creates `.agents/memory/index.md` and
`.agents/memory/component.md` only when the bundle does not exist. The initial
`Component Overview` concept is `status: draft` and contains prompts for the
component owner to replace. Existing bundles are validated and their generated
indexes are repaired without overwriting, renaming, or deleting concept files.
It creates no example category concept.

Project `init` creates missing `.agents/instructions/`, the OKF memory bundle,
and `.agents/changelog.md`, then performs the first project update. Project
`update` creates missing bundle and changelog scaffolding even when there are no
instruction source files. Both commands preserve existing concept and changelog
content. The changelog remains a separate human-authored file and is neither an
OKF concept nor a search candidate.

If `.agents/memory.md` is present, lifecycle commands fail with
`local_memory_invalid` and guidance to remove it and initialize the OKF bundle.
They never infer a conversion, copy its contents, or delete it. This legacy
preflight happens before project instruction targets are mutated.

`wagglebot brain remember` retains preview-by-default and writes only with
`--save`. `wagglebot brain status` reports the bundle path, concept count,
aggregate bundle hash, invalid/ready/missing/error state, and whether generated
indexes are current, stale, or missing. Help and agent instructions name
`.agents/memory/` as the only component-memory location.

## Agent Editing Contract

Agents and humans may edit the OKF Markdown files directly; the Repository
Brain is an optional convenience, not the owner of the content. Provisioned
base instructions and the repository-onboarding skill teach this workflow:

1. Read `.agents/memory/index.md` first and open only the relevant linked
   concepts.
2. Keep one durable repository fact or concept per non-reserved Markdown file
   in the matching semantic directory.
3. Update the existing concept instead of creating a duplicate; surface a
   contradiction before replacing reviewed knowledge.
4. When the engineer explicitly says to remember something, write or update
   the concept without judging importance. When told it is wrong, remove or
   correct that concept.
5. Never store transcripts, session summaries, guesses, secrets, or facts that
   source code already states more clearly.
6. Run `wagglebot update` after direct edits to validate the bundle and repair
   derived indexes, then commit the concept and index changes for pull-request
   review.

The generated instructions do not tell agents to read the entire corpus at
session start. Progressive indexes exist specifically to keep large memories
human-readable and context-efficient.

## MCP Contract Changes

The Phase 2 low-level MCP surface remains at schema version 1 because it has not
shipped as a usable public contract. Its local-memory shapes change before the
first release:

- search hits carry the exact concept path rather than `.agents/memory.md`;
- search returns the aggregate `bundleHash` instead of a per-file `fileHash`;
- proposals carry `baseBundleHash` and `path`;
- replacements identify `{ path, contentHash }`;
- saves return the concept `path`, prior/new bundle hashes, and the multi-file
  patch.

Local-memory evidence in the unified context contract accepts a bounded
`.agents/memory/**/*.md` repository-relative path. CodeGraph, Git, shared
memory, and Context Bridge contracts do not change.

## Failure Semantics

The provider fails loudly rather than silently omitting knowledge:

| Condition | Result |
|---|---|
| Bundle missing | Empty search plus initialization guidance |
| `.agents/memory.md` present | `local_memory_invalid` with OKF initialization guidance |
| Malformed frontmatter or missing `type` | `local_memory_invalid` naming only the repository-relative concept path |
| Bundle over 256 KiB | `local_memory_too_large` |
| Symlink or resolved path escapes bundle | `path_outside_repository` |
| Bundle changed after proposal | `memory_changed` |
| Filename/title conflict | `proposal_conflict` |
| Unsafe title, summary, evidence, or final concept | `secret_rejected` |

Errors never include absolute paths, concept bodies, queries, secrets, or raw
YAML parser output. A memory failure remains independent from CodeGraph and Git.

## Security and Privacy

- Secret scanning runs before proposal and again over the final concept before
  save.
- Recursive reads do not follow symlinks.
- All externally supplied paths pass the existing realpath and repository
  boundary policy.
- Logs contain state, counts, relative paths, hashes, and durations only.
- No transcript, prompt, query, hidden reasoning, or pending proposal is
  persisted.
- Retrieval and initialization make no network request.

## Documentation and Plan Impact

Implementation updates the current source of truth rather than preserving the
single-file design. Required documentation changes include D29, the Phase 1
provisioning and polish contracts, Phase 2 memory roadmap and sequence,
local-brain design and plan, unified-context design and plan, API reference,
README, onboarding skill, base agent template, CLI help, project lifecycle
commands and tests, and fixtures.

The original local-brain implementation remains useful for BM25, proposal
validation, secret scanning, atomic writes, provider composition, and MCP/CLI
structure. Only the single-file parser, write model, path literals, and their
documentation are replaced.

## Acceptance Criteria

1. `brain init` creates a conformant OKF v0.2 bundle and no
   `.agents/memory.md`.
2. Project `init`, project `update`, and `brain init` use the same idempotent
   bundle lifecycle; they preserve existing concepts and the separate agent
   changelog byte for byte while repairing only derived indexes.
3. Every saved memory is one concept file with parseable YAML frontmatter and a
   non-empty `type`.
4. Root and category indexes deterministically reflect all concepts.
5. Search returns exact concept paths, lines, and content from multiple files.
6. Add, duplicate, conflict, replace, tamper, concurrent-change, secret, size,
   malformed-YAML, and symlink cases have regression coverage.
7. `.agents/memory.md` is rejected rather than migrated or read, before project
   instruction targets are changed.
8. CLI, MCP, context evidence, templates, skills, fixtures, specifications, and
   plans consistently describe the bundle.
9. Agent guidance uses progressive discovery and one-concept-per-file direct
   editing while preserving Git and pull-request review.
10. Focused tests, repository tests, formatting, type checking, and build all
   pass, with no unrelated tracked changes.
