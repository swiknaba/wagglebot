# OKF Local Component Memory Design

**Status:** Approved architecture

> **Supersedes:** The single-file component-memory portions of
> [Local Repository Brain Design](2026-09-11-local-repository-brain-design.md),
> [Phase 2 Memory Roadmap](2026-09-11-phase-2-memory-roadmap.md), and D29 in
> [Wagglebot Design](2026-08-28-wagglebot-design.md).  
> **Standard:** [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)

## Decision

Repository-local component memory is an Open Knowledge Format (OKF) v0.2
bundle under `.agents/memory/`. Each durable memory or concept is one Markdown
file with YAML frontmatter. The bundle is committed and reviewed with the code
it describes.

`.agents/memory.md` is removed. Wagglebot has not shipped a usable consumer of
that format, so this first supported version has no legacy reader, migration
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

## Non-Goals

- Supporting or migrating `.agents/memory.md`.
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
└── memory/
    ├── index.md
    ├── purpose.md
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

The directory names retain the existing proposal categories. `Purpose` maps to
the root `purpose.md`; every other category maps to its lowercase directory.
Directories are created only when they contain a concept, so the committed
bundle never relies on empty directories.

The root `index.md` declares `okf_version: "0.2"` and links to `purpose.md` and
each populated category. A category `index.md` lists its concepts with their
frontmatter descriptions. Index files are deterministic derived views. Search
scans concept documents directly and does not treat indexes as knowledge.

## Concept Documents

Every non-reserved Markdown file is a conformant OKF concept:

```markdown
---
type: Warning
title: Retries can duplicate a charge
description: A timed-out charge must be reconciled before another write.
tags: [component-memory, warning]
status: stable
generated:
  by: wagglebot/0.2.1
  at: 2026-09-26T10:30:00Z
sources:
  - id: evidence-1
    resource: ../../../src/payments/charge.ts#L81
    title: src/payments/charge.ts:81
    kind: file
---

# Retries can duplicate a charge

A timed-out charge must be reconciled before another write.

## Evidence

- `src/payments/charge.ts:81`
```

Wagglebot-generated concepts use these fields:

- `type`: the singular category name (`Purpose`, `Architecture`, `Convention`,
  `Command`, `Decision`, `Warning`, or `Learning`);
- `title`: the proposal title;
- `description`: the proposal summary;
- `tags`: `component-memory` and the lowercase category;
- `status`: `stable`, because a concept is written only after an explicit save;
- `generated`: the CLI producer/version and save time;
- `sources`: one entry per proposal evidence item.

`sources[].kind` is an allowed OKF extension that preserves Wagglebot's existing
evidence classification. Repository file and ADR references become relative
paths from the concept document. Commit, issue, test, and maintainer references
remain portable scope descriptors. Each source also appears in the human-
readable `## Evidence` section.

Human-authored concepts need only the OKF-required non-empty `type`. The parser
accepts unknown types, unknown frontmatter keys, missing optional fields, and
broken links as required by OKF. A concept is invalid only when its Markdown is
not UTF-8 text, its YAML frontmatter is malformed, or `type` is missing or
empty. Reserved `index.md` files are parsed separately.

The complete bundle remains capped at 256 KiB, preserving the existing local
memory bound. Search chunks remain capped at 4,000 Unicode code points.

## Parsing and Retrieval

The provider recursively enumerates `.md` files under `.agents/memory/` without
following symbolic links. It rejects a resolved path outside the bundle,
malformed concept frontmatter, duplicate concept paths, invalid reserved files,
or a bundle over 256 KiB.

Each concept produces chunks from its title, description, heading ancestry,
and body. A long body is split at paragraph or sentence boundaries. Every
chunk records:

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

`LocalMemoryBundle.contentHash` hashes the sorted `(relative path, file hash)`
pairs for every concept and index. This is the optimistic-concurrency token for
a proposal.

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

`brain_memory_propose` validates and secret-scans the finished title, summary,
and evidence, then derives a lowercase ASCII kebab-case filename from the
title. An empty slug is invalid. The target is
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
concept documents as the authority. The command never stages or commits files.

## Initialization and CLI

`wagglebot brain init` creates `.agents/memory/index.md` and
`.agents/memory/purpose.md` only when the bundle does not exist. The initial
purpose concept is `status: draft` and contains prompts for the component owner
to replace. Existing bundles are validated and their indexes repaired without
overwriting concepts.

`wagglebot brain remember` retains preview-by-default and writes only with
`--save`. `wagglebot brain status` reports the bundle path, concept count,
aggregate content hash, and invalid/ready/missing state. Help and agent
instructions name `.agents/memory/` as the only component-memory location.

## MCP Contract Changes

The Phase 2 low-level MCP surface remains at schema version 1 because it has not
shipped as a usable public contract. Its local-memory shapes change before the
first release:

- search hits carry the exact concept path instead of the literal
  `.agents/memory.md` path;
- search returns `bundleHash` instead of `fileHash`;
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
unshipped single-file design. Required documentation changes include D29, the
Phase 1 provisioning contract, Phase 2 memory roadmap and sequence, local-brain
design and plan, unified-context design and plan, API reference, README,
onboarding skill, base agent template, CLI help, and fixtures.

The original local-brain implementation remains useful for BM25, proposal
validation, secret scanning, atomic writes, provider composition, and MCP/CLI
structure. Only the single-file parser, write model, path literals, and their
documentation are replaced.

## Acceptance Criteria

1. `brain init` creates a conformant OKF v0.2 bundle and no
   `.agents/memory.md`.
2. Every saved memory is one concept file with parseable YAML frontmatter and a
   non-empty `type`.
3. Root and category indexes deterministically reflect all concepts.
4. Search returns exact concept paths, lines, and content from multiple files.
5. Add, duplicate, conflict, replace, tamper, concurrent-change, secret, size,
   malformed-YAML, and symlink cases have regression coverage.
6. `.agents/memory.md` is rejected rather than migrated or read.
7. CLI, MCP, context evidence, templates, skills, fixtures, specifications, and
   plans consistently describe the bundle.
8. Focused tests, repository tests, formatting, type checking, and build all
   pass, with no unrelated tracked changes.
