# Local Repository Brain Design

**Status:** Approved architecture

> **Parent:** [Phase 2 Memory Roadmap](2026-09-11-phase-2-memory-roadmap.md)  
> **Inputs:** Phase 2 Memory Roadmap and the colleague's approved Wagglebot
> architecture decisions  
> **Plan:** [Local Repository Brain implementation plan](../plans/2026-09-11-local-repository-brain.md)

## Problem

Shared semantic memory cannot tell an agent what the current checkout contains,
which function calls another function, or why a particular line exists. Those
questions require local source and Git evidence. At the same time, repository
memory must remain readable, editable, and reviewable by humans.

The local repository brain supplies three independent sources:

1. committed component memory in `.agents/memory.md`;
2. current code structure through CodeGraph's local SQLite graph;
3. historical evidence through native Git commands.

It exposes typed provider interfaces for the later context engine. It does not
create a second long-term memory database.

## Goals

1. Give every supported agent the same component-memory, code-graph, and Git
   capabilities through the local MCP layer.
2. Keep component memory in one committed Markdown file under D29.
3. Build the CodeGraph index once, then update it incrementally across sessions.
4. Answer code relationship and impact questions from exact graph edges.
5. Answer history and `why` questions with commit, blame, and diff evidence.
6. Provide fast BM25 retrieval over local Markdown and bounded Git candidates.
7. Let an agent propose and explicitly promote durable knowledge learned during
   a chat without storing the conversation itself.
8. Mark missing, stale, dirty, or degraded evidence explicitly.
9. Keep every source file, graph, Git query, and absolute path on the
   workstation.

## Non-Goals

- A `.agent/` directory with task, plan, diary, handoff, or generated Markdown
  files. The colleague's D29 chooses one `.agents/memory.md`, and this design
  keeps that choice.
- Local semantic/vector storage. Component memory is small, structured, and
  served well by headings, exact matching, and BM25.
- Replacing `rg`, file reads, tests, the compiler, or runtime inspection.
- Treating Git commit text as guaranteed truth. It is evidence written by an
  author and may be incomplete.
- Uploading the repository or graph to the shared memory service.
- Automatically writing discoveries or current task state to Git without an
  explicit remember request or approval of a concrete memory proposal.
- Storing raw chats, transcript excerpts, hidden session summaries, or pending
  proposals on disk.
- Cross-repository graph construction in the first increment.

## Local Storage Boundary

```text
repository/
├── .agents/
│   ├── memory.md                  committed; human and agent maintained
│   └── instructions/*.md         existing Phase 1 instruction source
├── .wagglebot/
│   ├── catalog.yaml              optional component declaration
│   └── public.md                 optional reviewed org publication
├── catalog-info.yaml             Backstage alternative
├── codegraph.json                optional committed CodeGraph configuration
├── .codegraph/
│   └── codegraph.db              generated local SQLite/FTS5 graph; ignored
└── .git/                          authoritative history
```

No generated wake file, code map, history summary, or BM25 index is committed.
BM25 indexes are rebuilt in memory from the current source text. CodeGraph owns
all files under `.codegraph/`. Memory proposals exist only in the caller's
current context until they are saved; there is no proposal directory or queue.

## Component Memory Format

`wagglebot brain init` creates the file only when it does not exist:

```markdown
# Component Memory

## Purpose

Describe what this component owns and why it exists.

## Architecture

Record stable module boundaries, entry points, and dependencies.

## Conventions

Record component-specific rules that are not already in project instructions.

## Commands

- Build:
- Test:
- Check:
- Run:

## Decisions

Record accepted component decisions with links to ADRs, commits, or issues.

## Warnings

Record sharp edges that remain true in the current code.

## Learnings

Record durable, verified lessons. Include the evidence that confirms each one.
```

The headings are recommended retrieval categories, not a closed schema. The
parser preserves and indexes an unknown heading. It rejects invalid UTF-8,
binary content, a file larger than 256 KiB, or a file without an H1 heading.

The file holds stable component knowledge. Current tasks, speculative ideas,
temporary test failures, generated code inventories, and raw session notes do
not belong there. An agent changes it as an ordinary source file; the human
reviews the diff in the same pull request as related code.

Entries created through the helper use an H3 title and a compact, readable
shape:

```markdown
### Refresh tokens are single-use

Rotate a refresh token in one transaction; retrying the consumed token is a
security failure rather than an idempotent operation.

- Evidence: `src/auth/token-service.ts:81`, commit `abc1234`
- Added: 2026-09-11
```

The prose is the memory. The metadata keeps it verifiable. The helper does not
add opaque IDs, embeddings, scores, chat text, prompts, or agent reasoning to
the Markdown file.

## Local Memory Capture and Promotion

Local memory is curated, not continuously recorded. A fact reaches
`.agents/memory.md` through one of these paths:

1. **Manual edit.** A developer edits the Markdown file and reviews it through
   the repository's normal workflow.
2. **Explicit remember.** A developer says, for example, “remember that retries
   are unsafe here.” This instruction authorizes the agent to produce and save
   a concise entry during the same operation. The tool returns the applied diff
   for review; it does not ask for a redundant second confirmation.
3. **Agent suggestion.** At task completion or before context compaction, the
   agent may notice a durable discovery in its active chat context and call
   `brain_memory_propose`. The proposal is shown as a Markdown diff and remains
   ephemeral. Only an explicit “save,” “remember,” or “promote” instruction may
   pass it to `brain_memory_save`.

The coding agent performs the distillation because it already has the active
conversation. The local-brain service never receives a transcript and runs no
model. It accepts only the finished title, summary, target section, and evidence.
This keeps the useful conclusion while discarding conversational wording,
failed reasoning, and unrelated details.

### Eligibility

A proposal must be:

- specific to the current component;
- likely to matter in a later task;
- concise and actionable;
- verified by current code, a commit, an ADR, an issue, a test result, or an
  explicit maintainer statement; and
- suitable for review in Git.

Do not propose temporary task progress, guesses, already documented facts,
routine command output, secrets, personal data, or a summary of the whole chat.
Unresolved work stays in the task tracker or plan. Company-wide knowledge uses
the shared-memory publication path instead of the component file.

### Proposal and save contract

```typescript
type LocalMemorySection =
  | "Architecture"
  | "Conventions"
  | "Commands"
  | "Decisions"
  | "Warnings"
  | "Learnings";

type MemoryEvidence = {
  kind: "file" | "commit" | "adr" | "issue" | "test" | "maintainer_confirmation";
  ref: string;
};

type LocalMemoryProposalInput = {
  projectRoot: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { title: string; contentHash: string };
};

type LocalMemoryProposal = {
  proposalId: string;
  baseContentHash: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  action: "add" | "replace" | "no_change" | "needs_resolution";
  patch: string;
  warnings: string[];
};

type LocalMemorySaveResult = {
  path: ".agents/memory.md";
  action: "add" | "replace";
  previousContentHash: string;
  newContentHash: string;
  patch: string;
};
```

`brain_memory_propose` is pure with respect to the repository. It validates the
finished content, runs the local secret scan, compares it with existing entries,
and returns a deterministic proposal and unified diff. An exact duplicate
returns `no_change`. A same-title conflict or ambiguous near-duplicate returns
`needs_resolution` and cannot be saved until the caller submits a resolved
proposal. Replacement requires `replace.title` and `replace.contentHash` to
identify one exact current H3 entry; the service never guesses which prose to
overwrite.

`brain_memory_save` accepts the exact proposal and recomputes its ID. It refuses
to write if the current file hash differs from `baseContentHash`, if the content
now conflicts, or if the secret scan fails. It then writes a temporary file in
`.agents/`, renames it atomically, invalidates the BM25 cache, and returns the
new content hash and applied diff. It never stages or commits the file; normal
Git review remains visible to the developer.

Evidence references use repository-relative paths and line numbers, full or
short commit hashes, ADR/issue identifiers, or `maintainer confirmation on
YYYY-MM-DD`. Conversation text and session identifiers are never provenance.

### Local memory chunks

The Markdown provider produces one chunk per H2/H3 section and splits a section
larger than 4,000 Unicode code points at paragraph/sentence boundaries. Each
chunk contains:

```typescript
type LocalMemoryChunk = {
  id: string;                 // sha256(relative path + heading path + ordinal)
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};
```

Search returns `path:startLine`, heading ancestry, the exact current text, a
BM25 score, and a content hash. It never returns an uncited generated summary.

## Repository and Component Identity

The provider finds the Git root without reading or interpreting its remote. It
then finds the closest enclosing component declaration for the requested path:

1. `.wagglebot/catalog.yaml`, when present;
2. `catalog-info.yaml` otherwise.

The declaration supplies component, system, and owner. The company catalog
supplies the system's domain. Unknown or conflicting values are hard errors.

When the repository has no declaration, local memory, CodeGraph, and Git still
work. Shared system/domain retrieval is unavailable, and status explains which
declaration to add. The provider never invents a component or system name.

All tool calls require an absolute `projectPath`. The server canonicalizes it
with `realpath`, proves that it lies below a Git root, and uses argument arrays
rather than a shell when invoking Git. A requested file must remain below that
root after symlink resolution.

## CodeGraph Integration

The implementation pins `@colbymchenry/codegraph` at `1.6.0` and uses its
documented TypeScript `CodeGraph` class through this adapter:

```typescript
type CodeGraphProvider = {
  initialize(projectRoot: string): Promise<CodeGraphStatus>;
  status(projectRoot: string): Promise<CodeGraphStatus>;
  explore(input: {
    projectRoot: string;
    query: string;
    maxNodes: number;
    includeCode: boolean;
  }): Promise<CodeGraphResult>;
  close(): Promise<void>;
};

type CodeGraphStatus = {
  state: "missing" | "indexing" | "ready" | "pending" | "error";
  projectRoot: string;
  pendingFiles: string[];
  observedAt: string;
  message?: string;
};
```

`initialize` calls `CodeGraph.init`, builds the initial index, and starts its
watcher. A normal session calls `CodeGraph.open`; connect-time reconciliation
and the watcher update changed files. Wagglebot never deletes and rebuilds a
healthy graph at session start.

The adapter keeps at most eight open project handles in an LRU map. Eviction
stops the watcher and closes the database cleanly. One local context-engine
process owns these handles so two harnesses do not create competing embedded
writers. Shutdown closes every handle.

CodeGraph represents the current working tree, including uncommitted changes.
It is therefore misleading to describe freshness only as a Git commit match.
Every response reports:

- current Git HEAD;
- current branch or detached state;
- dirty/clean working-tree state;
- CodeGraph state and pending-file list;
- query timestamp;
- any staleness banner returned by CodeGraph.

When a result names a pending file, it is marked `stale` and the caller is told
to read that file directly before relying on the snippet. An absent index gives
clear `wagglebot brain init` guidance and does not prevent local memory or Git
retrieval.

### Repository configuration

CodeGraph requires no committed configuration for normal repositories. A team
may commit `codegraph.json` for documented upstream options such as:

```json
{
  "exclude": ["static/vendor/**"],
  "deprioritize": ["examples/**", "scripts/**"],
  "extensions": {
    ".tpl": "php"
  }
}
```

`wagglebot brain init` ensures `.codegraph/` is ignored. It does not create
`codegraph.json` unless the user supplies repository-specific values.

Wagglebot sets `CODEGRAPH_TELEMETRY=0` for its embedded process by default.
Changing that value is an explicit company/workstation policy decision. No
CodeGraph telemetry setting is inferred from a developer's unrelated global
installation.

## Why SQLite Remains Correct

The CodeGraph SQLite database and pgvector answer different questions:

- SQLite stores exact symbols and typed edges such as calls, imports, extends,
  and implements. FTS5 finds exact names.
- Pgvector retrieves text that is semantically similar to a natural-language
  query.

A vector index cannot prove that `A` calls `B`, enumerate all callers, or trace
an impact radius. Moving CodeGraph rows into pgvector would discard the exact
graph operations and add a shared-data risk. The local SQLite database remains
generated, replaceable, and specialized.

## Git Intelligence

The Git provider uses the installed `git` binary with explicit argument arrays.
It never interpolates user text into a shell command.

```typescript
type GitProvider = {
  status(projectRoot: string): Promise<GitStatus>;
  recent(input: { projectRoot: string; path?: string; limit: number }): Promise<GitCommit[]>;
  history(input: { projectRoot: string; path: string; limit: number }): Promise<GitCommit[]>;
  blame(input: { projectRoot: string; path: string; startLine: number; endLine: number }): Promise<BlameLine[]>;
  why(input: GitWhyInput): Promise<GitWhyResult>;
};

type GitWhyInput = {
  projectRoot: string;
  path: string;
  startLine?: number;
  endLine?: number;
  query?: string;
  maxCommits?: number;
};
```

`git.why` is evidence retrieval, not an LLM assertion:

1. Validate and normalize the repository-relative path.
2. Use porcelain status to record whether the current file is dirty.
3. When lines are supplied, run porcelain blame for that range.
4. Run path history with rename following, including commit subject and body.
5. Select at most 200 candidate commits and build an in-memory BM25 index over
   subject, body, and changed paths.
6. Boost blame commits and exact hashes above keyword-only matches.
7. Fetch bounded metadata and relevant diff hunks for the top five commits.
8. Return evidence and clearly labeled observations. Do not invent motivation
   missing from the commit or diff.

The result shape is:

```typescript
type GitWhyResult = {
  path: string;
  requestedLines?: { start: number; end: number };
  workingTree: "clean" | "dirty";
  head: string;
  evidence: Array<{
    commit: string;
    subject: string;
    body?: string;
    authorDate: string;
    authors: string[];
    reason: "blame" | "exact_hash" | "bm25" | "recent_path_change";
    score: number;
    changedPaths: string[];
    diffHunks: string[];
  }>;
  limitations: string[];
};
```

Names and email addresses are returned only when already present in local Git
metadata and requested by the caller. They are never sent to shared services or
logs.

### Bounds

- `maxCommits` defaults to 100 and is capped at 200.
- At most five commits include diff hunks.
- Each diff hunk is capped at 200 lines and 32 KiB.
- Total Git output per operation is capped at 1 MiB.
- A Git subprocess times out after 10 seconds and is terminated.
- Binary diffs are reported by path and commit without binary content.
- Shallow history is reported as a limitation.

## Local BM25

The local brain implements one small, deterministic BM25 scorer rather than
adding a search service. It tokenizes Unicode letters and numbers, lowercases,
keeps identifiers in both full and camel/snake-case split forms, and preserves
exact commit hashes and paths.

Defaults are `k1 = 1.2` and `b = 0.75`. The index exists only in process and is
keyed by source content hash. It is rebuilt when `.agents/memory.md` changes or
for each bounded Git candidate set.

Exact heading, symbol, path, and commit-hash matches sort ahead of BM25 ties.
Scores from this index are meaningful only within one candidate set. The later
context engine merges ranked lists through reciprocal-rank fusion instead of
adding BM25 to vector similarity.

## Provider Interfaces

The package consumed by the context engine exports:

```typescript
type LocalBrain = {
  identify(projectPath: string): Promise<ProjectIdentity>;
  memory: LocalMemoryProvider;
  code: CodeGraphProvider;
  git: GitProvider;
  status(projectPath: string): Promise<LocalBrainStatus>;
  close(): Promise<void>;
};

type LocalMemoryProvider = {
  read(projectRoot: string): Promise<LocalMemoryDocument | undefined>;
  search(input: { projectRoot: string; query: string; limit: number }): Promise<LocalMemoryHit[]>;
  propose(input: LocalMemoryProposalInput): Promise<LocalMemoryProposal>;
  save(input: { projectRoot: string; proposal: LocalMemoryProposal }): Promise<LocalMemorySaveResult>;
};
```

Methods return structured data. Formatting Markdown for an agent belongs to the
unified context engine.

## CLI Behavior

### `wagglebot brain init [path]`

1. Find the Git root and component declaration.
2. Create `.agents/memory.md` from the fixed template only if absent.
3. Add a Wagglebot-owned `.codegraph/` ignore block when no effective ignore
   rule exists.
4. Initialize and index CodeGraph.
5. Print component identity, memory path, graph state, symbol/file counts, Git
   HEAD, and any missing-catalog warning.

Existing memory is never overwritten. An invalid existing file fails with a
path and reason. D37 applies, so there is no `--dry-run`.

### `wagglebot brain remember [path]`

This CLI is the non-agent equivalent of the two MCP operations. It requires
`--section`, `--title`, `--summary`, and at least one `--evidence kind:ref`.
Without `--save`, it prints the proposal and diff and changes nothing. `--save`
applies the proposal against the content hash observed during that invocation.
It never accepts a transcript file or recursively reads the repository.

### `wagglebot brain status [path]`

Prints machine-readable JSON with `--json`; otherwise prints a short report:

```text
Component memory  ready  .agents/memory.md, 7 sections
Code graph         ready  no pending files
Git                ready  main@3e11fc9, dirty
Catalog            ready  wagglebot / wagglebot-system / developer-tools
Shared memory      not checked by this command
```

Status never modifies the graph or repository.

## Low-Level MCP Operations

The local-brain milestone makes these provider operations available for testing
and advanced use:

- `local_memory_search`
- `brain_memory_propose`
- `brain_memory_save`
- `codegraph_explore`
- `git_history`
- `git_why`
- `local_brain_status`

The unified context engine later adds the smaller recommended `brain_*` surface.
The hub's CodeMode transform may hide these operations from the default tool
list while retaining them for `execute` and diagnostics.

## Failure Behavior

| Failure | Behavior |
|---|---|
| `.agents/memory.md` missing | Return no local-memory hits and initialization guidance; CodeGraph and Git continue. |
| Markdown invalid/too large | Mark local memory unavailable with exact path/reason; do not return partial text. |
| Proposal contains a secret or absolute path | Reject it before constructing a writable patch. |
| Proposal duplicates an entry | Return `no_change`; write nothing. |
| Proposal conflicts with an entry | Return `needs_resolution`; write nothing. |
| Memory changed after proposal | Return `memory_changed`; require a new proposal against the current file. |
| Atomic save fails | Leave the original file intact and return a stable write error. |
| CodeGraph index missing | Return `state: missing`; other sources continue. |
| CodeGraph has pending files | Return results with stale warnings and name only repository-relative pending files. |
| CodeGraph throws or locks | Close the handle, retry open once, then degrade without deleting its database. |
| Git binary/repository unavailable | Git provider fails independently; local memory and CodeGraph continue. |
| Git history shallow | Return available evidence and a limitation; never fetch a remote automatically. |
| Requested path escapes root | Reject before any file or Git operation. |

## Security and Privacy

- Bind the local MCP server to stdio or loopback only.
- Resolve and validate every project and file path.
- Never follow a symlink outside the Git root.
- Respect CodeGraph's ignore rules and `.gitignore`; company policy may add
  required excludes.
- Never run `git fetch`, contact a remote, or enable CodeGraph telemetry
  automatically.
- Never log source snippets, commit bodies, queries, memory content, absolute
  paths, or environment values.
- Return repository-relative paths to agents whenever possible.
- Reject `.env*`, private-key, credential, and configured secret paths from any
  content-returning provider even if a repository mistakenly tracks them.
- Use the same fail-closed `@wagglebot/secret-scanner` package as shared-memory
  writes; scan proposed content before rendering and again before saving.
- Accept only a finished summary from the caller; never accept, request, or log
  a transcript as proposal input.

## Performance Targets

- Parse and index a 256 KiB memory file below 100 ms after process warm-up.
- Local-memory search below 50 ms.
- Local-memory proposal generation below 100 ms, excluding caller-side
  summarization; atomic save below 100 ms for a valid 256 KiB file.
- CodeGraph symbol lookup below 200 ms when the graph is ready.
- CodeGraph exploratory context below 1 second for the pilot repositories.
- Git history/why below 1 second for normal repositories and below 3 seconds at
  the configured 200-commit cap.
- Session startup opens an existing graph; it does not block on a full rebuild.

## Test Strategy

1. Unit tests cover Markdown parsing, chunk IDs, proposal rendering,
   duplicate/conflict detection, optimistic hash checks, atomic writes, BM25
   tokenization/ranking, path validation, repository identity, and Git parser
   fixtures.
2. CodeGraph compatibility tests run against pinned 1.6.0 and assert initialize,
   reopen, watch/sync, explore, status, and clean shutdown.
3. Git integration tests create real temporary repositories with renames,
   branches, dirty changes, blame ranges, multiline messages, binary files, and
   shallow clones.
4. CLI tests prove non-destructive initialization, idempotency, ignore-block
   ownership, and JSON status.
5. MCP contract tests prove proposal/save authorization boundaries, structured
   errors, and independent degradation.
6. Privacy tests assert logs contain none of the fixture source, path, query,
   commit body, or environment values.

## Acceptance Criteria

1. A human can open and review every durable component memory in
   `.agents/memory.md`.
2. A second `brain init` changes no tracked file and does not rebuild a healthy
   CodeGraph index.
3. Closing and reopening an agent retains the local graph; changing one source
   file triggers an incremental update.
4. CodeGraph answers callers/callees/impact from SQLite graph relationships,
   independent of pgvector and the shared service.
5. `git.why` returns commit hashes, messages, dates, paths, and bounded diff
   evidence, with limitations when motivation is absent.
6. Local memory exact identifiers and relevant prose rank above unrelated
   sections in BM25 tests.
7. Missing shared infrastructure has no effect on local operation.
8. No local source, graph, Git text, or absolute path leaves the workstation.
9. The implementation pins CodeGraph 1.6.0 and disables its telemetry by
   default.
10. An explicit “remember this” request saves one concise, evidence-bearing
    entry and returns its diff without retaining the chat.
11. An agent-originated suggestion changes no file until the developer promotes
    the displayed proposal.
12. Concurrent edits, duplicates, conflicts, and secret-like content cannot
    silently corrupt or pollute `.agents/memory.md`.

## Upstream Reference

- [CodeGraph repository and documentation](https://github.com/colbymchenry/codegraph)

The evaluated upstream documents its generated `.codegraph/` SQLite/FTS5 index,
incremental watcher, staleness signals, MCP operation, and public TypeScript API.
An upstream upgrade must rerun the adapter compatibility suite before the pin
changes.
