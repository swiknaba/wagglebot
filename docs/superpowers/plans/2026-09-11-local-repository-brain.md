# Local Repository Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add human-readable component memory with explicit proposal/promotion, a persistent local CodeGraph index, Git evidence retrieval, and low-level MCP operations without sending repository data to shared services.

**Architecture:** A focused `@wagglebot/local-brain` package exposes Markdown, CodeGraph, and Git providers as structured TypeScript interfaces. Local memory changes use a deterministic, transcript-free proposal followed by an optimistic, atomic save. CodeGraph 1.6.0 owns its generated `.codegraph/` SQLite graph and incrementally updates it; native Git commands provide bounded historical evidence; an in-process BM25 index searches Markdown and Git candidates. The CLI initializes, proposes/saves memory, and reports local state, while a minimal local MCP service exposes the providers before the unified engine is added.

**Tech Stack:** TypeScript 5.9.2, Bun, Node 22.20+, `@colbymchenry/codegraph` 1.6.0, `@modelcontextprotocol/sdk` 1.30.0, native Git, Bun tests, Biome.

**Spec:** `docs/superpowers/specs/2026-09-11-local-repository-brain-design.md`

## Global Constraints

- Keep `.agents/memory.md` as the only durable component-memory file.
- Keep proposals ephemeral. Do not create a proposal cache, session file, or
  transcript store.
- Accept only a finished title, summary, section, and evidence from the caller;
  never pass a chat transcript to the local-brain service.
- A developer's explicit remember/save instruction authorizes proposal and
  save. An agent-originated suggestion must stop after proposal until the
  developer explicitly promotes it.
- Scan before proposal and save, require the proposal's base content hash, and
  write atomically without staging or committing.
- Keep `.codegraph/` generated and ignored. Never commit, upload, or copy its database.
- Do not create `.agent/`, generated wake Markdown, a local vector database, diaries, handoffs, or transcript storage.
- Pin `@colbymchenry/codegraph` exactly at `1.6.0`; never call its upgrade command automatically.
- Set `CODEGRAPH_TELEMETRY=0` before loading the CodeGraph module.
- Never call `git fetch`, read a remote to infer identity, or invoke Git through a shell.
- Validate `realpath` for every project/file input and reject a symlink escape.
- Never return or index configured secret paths, even when Git tracks them.
- Provider failures are independent. A missing graph must not break Markdown or Git.
- Log identifiers, state, counts, and durations only. Never log queries, content, commit bodies, source snippets, absolute paths, or environment values.
- Treat the v1 tool inputs, results, bounds, idempotency behavior, and stable
  errors in `docs/api-reference.md` as authoritative. In particular, cap
  proposal titles at 80 code points, summaries at 1,000, evidence at 20,
  CodeGraph results at 100 nodes, and local search at 20 hits.
- Run `bun run check && bun run typecheck && bun test` at every green-tree checkpoint.

---

## File Map

```text
packages/local-brain/
  package.json
  src/index.ts
  src/types.ts
  src/path-policy.ts
  src/project-identity.ts
  src/bm25/tokenize.ts
  src/bm25/index.ts
  src/memory/parse.ts
  src/memory/provider.ts
  src/memory/proposal.ts
  src/memory/write.ts
  src/codegraph/provider.ts
  src/git/runner.ts
  src/git/parse.ts
  src/git/provider.ts
  src/git/why.ts
  src/local-brain.ts
  src/**/*.test.ts
  integration/codegraph.test.ts
  integration/git.test.ts

services/context-engine/
  package.json
  src/mcp/low-level.ts
  src/mcp/low-level.test.ts
  src/index.ts

packages/cli/
  templates/component-memory.md
  src/commands/brain-init.ts
  src/commands/brain-init.test.ts
  src/commands/brain-remember.ts
  src/commands/brain-remember.test.ts
  src/commands/brain-status.ts
  src/commands/brain-status.test.ts
  src/index.ts
  src/help.ts
  src/help.test.ts
```

`packages/local-brain` contains no MCP formatting and no shared-memory client. `services/context-engine` initially adapts its structured providers to low-level MCP tools; the Unified Context Engine plan extends the same service.

---

### Task 1: Create local-brain types and deterministic BM25

**Files:**
- Create: `packages/local-brain/package.json`
- Create: `packages/local-brain/src/index.ts`
- Create: `packages/local-brain/src/types.ts`
- Create: `packages/local-brain/src/bm25/tokenize.ts`
- Create: `packages/local-brain/src/bm25/tokenize.test.ts`
- Create: `packages/local-brain/src/bm25/index.ts`
- Create: `packages/local-brain/src/bm25/index.test.ts`

**Interfaces:**
- Produces: provider result types, `tokenize(text): string[]`, and `Bm25Index<T>.search(query, limit): Ranked<T>[]`.
- Consumes: `@wagglebot/contracts` from the Shared Memory Foundation milestone.

- [ ] **Step 1: Write failing tokenizer and ranking tests**

```typescript
test("keeps identifiers whole and adds camel/snake segments", () => {
  expect(tokenize("TokenService.rotate refresh_token abc1234")).toEqual([
    "tokenservice", "token", "service", "rotate", "refresh_token", "refresh", "token", "abc1234",
  ]);
});

test("an exact identifier ranks its section first", () => {
  const index = new Bm25Index([
    { id: "architecture", text: "TokenService owns refresh token rotation" },
    { id: "testing", text: "Run integration tests with Bun" },
  ], (x) => x.text);
  expect(index.search("TokenService", 2)[0]?.item.id).toBe("architecture");
});
```

Add tests for Unicode letters/numbers, commit hashes, paths, empty documents, stable ties, and limit bounds.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `bun test packages/local-brain/src/bm25`

Expected: FAIL with missing modules.

- [ ] **Step 3: Add the package and public types**

Create `packages/local-brain/package.json`:

```json
{
  "name": "@wagglebot/local-brain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@colbymchenry/codegraph": "1.6.0",
    "@wagglebot/contracts": "workspace:*",
    "@wagglebot/secret-scanner": "workspace:*",
    "yaml": "2.8.3"
  }
}
```

Define `ProjectIdentity`, `LocalMemoryChunk`, `LocalMemoryHit`,
`LocalMemorySection`, `MemoryEvidence`, `LocalMemoryProposalInput`,
`LocalMemoryProposal`, `LocalMemorySaveResult`, `CodeGraphStatus`,
`CodeGraphResult`, `GitStatus`, `GitCommit`, `GitWhyInput`, `GitWhyResult`, and
`LocalBrainStatus` exactly as the spec. Export them from `src/index.ts`.

- [ ] **Step 4: Implement BM25 with fixed parameters**

Use `k1 = 1.2`, `b = 0.75`, and natural-log inverse document frequency:

```typescript
const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
const score = idf * ((frequency * (K1 + 1)) / (frequency + K1 * (1 - B + B * documentLength / averageLength)));
```

Normalize exact identifiers only for case. Sort equal scores by input order and then stable ID. Do not persist the index.

- [ ] **Step 5: Test and commit**

Run: `bun test packages/local-brain/src/bm25 && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/local-brain bun.lock
git commit -m "feat(brain): add local provider types and BM25"
```

---

### Task 2: Enforce project identity and path policy

**Files:**
- Create: `packages/local-brain/src/path-policy.ts`
- Create: `packages/local-brain/src/path-policy.test.ts`
- Create: `packages/local-brain/src/project-identity.ts`
- Create: `packages/local-brain/src/project-identity.test.ts`

**Interfaces:**
- Produces: `resolveProjectPath(input): Promise<ResolvedProject>`, `resolveSafeFile(project, input): Promise<string>`, `isSecretPath(relative): boolean`, and `identifyProject(projectPath, companyCatalog?): Promise<ProjectIdentity>`.
- Consumes: the Phase 1 component and catalog formats.

- [ ] **Step 1: Write failing path and identity tests**

```typescript
test("rejects a symlink that leaves the Git root", async () => {
  const repo = await fixtureRepo();
  symlinkSync(tmpdir(), join(repo, "escape"));
  await expect(resolveSafeFile(await resolveProjectPath(repo), "escape/private.txt")).rejects.toThrow(/outside Git root/);
});

test("wagglebot component declaration wins over catalog-info", async () => {
  const repo = await repoWithBothDeclarations("preferred-component", "backstage-component");
  expect((await identifyProject(repo, companyCatalog())).component).toBe("preferred-component");
});

test("identity never reads the Git remote", async () => {
  const exec = recordingGit();
  await identifyProject(await repoWithoutDeclaration(), companyCatalog(), exec);
  expect(exec.args.flat()).not.toContain("remote");
});
```

Add closest-enclosing declaration, unknown system, no declaration, detached HEAD, and deny-list tests for `.env`, `*.pem`, `*.key`, `credentials/`, and `secrets/`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/local-brain/src/path-policy.test.ts packages/local-brain/src/project-identity.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement canonical root/path validation**

Call `git rev-parse --show-toplevel` with the candidate directory as `cwd`. Canonicalize returned and requested paths with `realpath`. Use `relative(root, file)` and reject `..`, absolute relative output, NUL, and deny-list matches.

```typescript
export function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new LocalBrainError("path_outside_repository", "requested path resolves outside Git root");
}
```

- [ ] **Step 4: Implement component resolution**

Walk from the requested directory toward the Git root. In each directory, load `.wagglebot/catalog.yaml` first and `catalog-info.yaml` second. Stop at the closest declaration. Validate the component/system/owner against the supplied company catalog. Return local-only identity with an explicit `catalogWarning` when no declaration exists.

- [ ] **Step 5: Test and commit**

Run: `bun test packages/local-brain/src/path-policy.test.ts packages/local-brain/src/project-identity.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/local-brain/src/path-policy* packages/local-brain/src/project-identity*
git commit -m "feat(brain): resolve repository identity safely"
```

---

### Task 3: Parse, search, propose, and save `.agents/memory.md`

**Files:**
- Create: `packages/local-brain/src/memory/parse.ts`
- Create: `packages/local-brain/src/memory/parse.test.ts`
- Create: `packages/local-brain/src/memory/provider.ts`
- Create: `packages/local-brain/src/memory/provider.test.ts`
- Create: `packages/local-brain/src/memory/proposal.ts`
- Create: `packages/local-brain/src/memory/proposal.test.ts`
- Create: `packages/local-brain/src/memory/write.ts`
- Create: `packages/local-brain/src/memory/write.test.ts`

**Interfaces:**
- Produces: `parseMemory(text, path): LocalMemoryDocument` and
  `MarkdownMemoryProvider.read/search/propose/save`.
- Consumes: path policy, content hashing, `Bm25Index`, and
  `@wagglebot/secret-scanner` from the Shared Memory Foundation milestone.

- [ ] **Step 1: Write failing parser/provider tests**

```typescript
test("chunks H2 and H3 sections with line provenance", () => {
  const doc = parseMemory("# Component Memory\n\n## Warnings\n\nDo not retry writes.\n\n### Database\n\nThe lock is intentional.\n", ".agents/memory.md");
  expect(doc.chunks.map((x) => ({ headings: x.headingPath, start: x.startLine }))).toEqual([
    { headings: ["Warnings"], start: 5 },
    { headings: ["Warnings", "Database"], start: 9 },
  ]);
});

test("search invalidates its cache when the file changes", async () => {
  const provider = new MarkdownMemoryProvider();
  writeMemory(repo, "## Decisions\n\nUse SQLite.");
  expect((await provider.search({ projectRoot: repo, query: "SQLite", limit: 5 })).length).toBe(1);
  writeMemory(repo, "## Decisions\n\nUse PostgreSQL.");
  expect((await provider.search({ projectRoot: repo, query: "SQLite", limit: 5 })).length).toBe(0);
});

test("an explicit finished fact becomes a reviewable proposal without writing", async () => {
  const before = readMemory(repo);
  const proposal = await provider.propose({
    projectRoot: repo,
    section: "Warnings",
    title: "Retries can duplicate a charge",
    summary: "Do not retry a timed-out charge until its idempotency record is checked.",
    evidence: [{ kind: "file", ref: "src/payments/charge.ts:74" }],
  });
  expect(proposal.action).toBe("add");
  expect(proposal.patch).toContain("### Retries can duplicate a charge");
  expect(readMemory(repo)).toBe(before);
  expect(JSON.stringify(proposal)).not.toContain("chat");
});

test("save rejects a proposal after concurrent memory editing", async () => {
  const proposal = await provider.propose(validProposalInput(repo));
  writeMemory(repo, `${readMemory(repo)}\n### Maintainer edit\n\nKeep this.\n`);
  await expect(provider.save({ projectRoot: repo, proposal })).rejects.toMatchObject({
    code: "memory_changed",
  });
});
```

Add unknown headings, long section splitting, invalid UTF-8, missing H1, empty
body, file-size cap, exact heading boost, missing-file, exact duplicate,
same-title conflict, ambiguous near-duplicate, secret fixture, absolute evidence
path, tampered proposal ID, atomic-write failure, and cache invalidation cases.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/local-brain/src/memory`

Expected: FAIL.

- [ ] **Step 3: Implement deterministic Markdown parsing**

Read at most 256 KiB. Reject NUL bytes and decoding replacement characters. Track fenced code blocks so `##` inside a fence is not a heading. Build H2/H3 chunks, preserve line ranges and heading ancestry, and split content above 4,000 Unicode code points at paragraphs/sentences without overlap.

Stable IDs use:

```typescript
createHash("sha256").update([relativePath, headings.join(" / "), ordinal].join("\0")).digest("hex")
```

- [ ] **Step 4: Implement cached in-process search**

Cache by `(projectRoot, file contentHash)`, not mtime alone. Search BM25 text containing heading path plus content. Add an exact-heading/identifier tie-break while retaining the BM25 score and rank. Return exact current text with `.agents/memory.md:startLine` provenance.

- [ ] **Step 5: Implement pure proposal construction**

Accept only a finished `section`, `title`, `summary`, and non-empty `evidence`
array. Bound the title to 80 Unicode code points and summary to 1,200; normalize
line endings but preserve prose. Reject NUL, control characters, absolute file
paths, parent traversal, transcript/session fields, and unknown evidence kinds.
Run the shared scanner over title, summary, and evidence references before
rendering.

Read and hash the current memory file. Match normalized H3 titles within the
target H2 section and compare normalized bodies. Return `no_change` for exact
content, `needs_resolution` for a different same-title body or an ambiguous
near-duplicate, and otherwise render `add`. Render `replace` only when the input
contains `replace: { title, contentHash }` and both fields match one current H3
entry. Never write in this method.

Render this stable human-readable form and a unified diff:

```markdown
### Retries can duplicate a charge

Do not retry a timed-out charge until its idempotency record is checked.

- Evidence: `src/payments/charge.ts:74`
- Added: 2026-09-11
```

Compute `proposalId` as SHA-256 over the schema version, base content hash,
action, section, normalized title, normalized summary, ordered evidence, and
rendered replacement text. Do not include a transcript, prompt, model output,
agent reasoning, session ID, or opaque metadata in the proposal or Markdown.

- [ ] **Step 6: Implement optimistic atomic save**

Revalidate the project root and proposal schema, recompute `proposalId`, reread
and rescan the complete proposed content, and require the current content hash
to equal `baseContentHash`. Reject `no_change` and `needs_resolution` as
non-writable. Re-render from the structured fields and reject a supplied patch
that differs. Write a mode-`0600` temporary file in `.agents/`, `fsync` it,
change it to the existing file mode (or `0644` for a newly initialized file),
rename it over `memory.md`, and clean up the temporary path in `finally`. Do not
stage or commit. Invalidate the old BM25 cache key and return relative path,
new hash, and applied diff.

- [ ] **Step 7: Test and commit**

Run: `bun test packages/local-brain/src/memory && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/local-brain/src/memory
git commit -m "feat(brain): curate committed component memory"
```

---

### Task 4: Adapt CodeGraph 1.6.0 and prove persistence/incremental updates

**Files:**
- Create: `packages/local-brain/src/codegraph/provider.ts`
- Create: `packages/local-brain/src/codegraph/provider.test.ts`
- Create: `packages/local-brain/integration/codegraph.test.ts`

**Interfaces:**
- Produces: `CodeGraphProvider.initialize`, `.status`, `.explore`, and `.close`.
- Consumes: CodeGraph's public `CodeGraph.init`, `CodeGraph.open`, `indexAll`, `buildContext`, `watch`, `unwatch`, and `close` APIs.

- [ ] **Step 1: Write mocked lifecycle tests**

```typescript
test("a normal query opens an existing index and never reinitializes it", async () => {
  const api = fakeCodeGraphApi({ indexed: true });
  const provider = new CodeGraphProvider({ api, maxOpenProjects: 2 });
  await provider.explore({ projectRoot: repo, query: "TokenService", maxNodes: 20, includeCode: true });
  expect(api.openCalls).toEqual([repo]);
  expect(api.initCalls).toEqual([]);
  expect(api.indexAllCalls).toEqual([]);
});

test("LRU eviction unwatches and closes the oldest project", async () => {
  const api = fakeCodeGraphApi({ indexed: true });
  const provider = new CodeGraphProvider({ api, maxOpenProjects: 1 });
  await provider.explore(input(repoA));
  await provider.explore(input(repoB));
  expect(api.handles.get(repoA)?.unwatchCalls).toBe(1);
  expect(api.handles.get(repoA)?.closeCalls).toBe(1);
});
```

Add missing index, pending-file staleness, one retry after lock/open error, query/max-node validation, and shutdown tests.

- [ ] **Step 2: Run unit tests and confirm failure**

Run: `bun test packages/local-brain/src/codegraph/provider.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement a lazy upstream loader and handle cache**

Set telemetry before dynamic import:

```typescript
const loadCodeGraph = async () => {
  process.env.CODEGRAPH_TELEMETRY ??= "0";
  const module = await import("@colbymchenry/codegraph");
  return module.default;
};
```

Use canonical project roots as LRU keys. `initialize` calls `init`, `indexAll`, and `watch`. `explore` opens an existing graph, starts `watch`, and calls `buildContext`. Parse any upstream staleness banner into structured `pendingFiles` while retaining the original result text as code evidence.

- [ ] **Step 4: Write and run the real compatibility test**

The integration test creates a small TypeScript repository with `entry → service → repository` calls, initializes once, closes, reopens in a new provider, queries callers, changes one call target, waits on a controllable watcher/status condition for at most five seconds, and proves the result changes without deleting `.codegraph/`.

Run: `CODEGRAPH_TELEMETRY=0 bun test packages/local-brain/integration/codegraph.test.ts`

Expected: PASS and `.codegraph/codegraph.db` exists in the temporary repository after both provider instances close.

- [ ] **Step 5: Verify no telemetry/network attempt in tests**

Run the integration test with outbound connections denied by the test harness and assert the provider environment contains `CODEGRAPH_TELEMETRY=0`. Expected: PASS.

- [ ] **Step 6: Commit the adapter**

```bash
git add packages/local-brain/src/codegraph packages/local-brain/integration/codegraph.test.ts bun.lock
git commit -m "feat(brain): integrate the persistent local CodeGraph"
```

---

### Task 5: Implement bounded Git history and `git.why`

**Files:**
- Create: `packages/local-brain/src/git/runner.ts`
- Create: `packages/local-brain/src/git/runner.test.ts`
- Create: `packages/local-brain/src/git/parse.ts`
- Create: `packages/local-brain/src/git/parse.test.ts`
- Create: `packages/local-brain/src/git/provider.ts`
- Create: `packages/local-brain/src/git/why.ts`
- Create: `packages/local-brain/src/git/why.test.ts`
- Create: `packages/local-brain/integration/git.test.ts`

**Interfaces:**
- Produces: `GitProvider.status`, `.recent`, `.history`, `.blame`, `.why`.
- Consumes: path policy, injected `spawn`, and `Bm25Index`.

- [ ] **Step 1: Write failing runner/parser tests**

```typescript
test("passes a hostile query only as an argument and never to a shell", async () => {
  const spawn = recordingSpawn();
  await new GitRunner(spawn).run(repo, ["log", "--", "$(touch pwned)"]);
  expect(spawn.calls[0]).toMatchObject({ command: "git", args: ["log", "--", "$(touch pwned)"], shell: false });
});

test("parses multiline commit bodies with NUL record separators", () => {
  const commits = parseLog(`abc\u0000subject\u0000line one\nline two\u00002026-09-11T10:00:00Z\u0000A Name\u0000\u001e`);
  expect(commits[0]?.body).toBe("line one\nline two");
});
```

- [ ] **Step 2: Write failing `why` ranking tests**

```typescript
test("blame and exact-hash evidence rank above keyword-only history", async () => {
  const result = await whyProvider(fixtureHistory()).why({
    projectRoot: repo,
    path: "src/token.ts",
    startLine: 10,
    endLine: 12,
    query: "why rotate once",
  });
  expect(result.evidence[0]?.reason).toBe("blame");
  expect(result.evidence).toHaveLength(5);
});
```

Add rename-following, dirty file, detached branch, shallow repository, binary diff, 200-commit cap, 32-KiB hunk cap, 1-MiB process cap, timeout, and absent-motivation limitations.

- [ ] **Step 3: Run tests and confirm failure**

Run: `bun test packages/local-brain/src/git`

Expected: FAIL.

- [ ] **Step 4: Implement the safe Git runner and parsers**

Use `Bun.spawn` or `node:child_process.spawn` with `shell: false`, explicit `cwd`, a 10-second timer, and capped stdout/stderr collectors. Parse `git status --porcelain=v2 -z`, `git log --follow --format=<NUL format>`, and `git blame --line-porcelain` without line-oriented assumptions for filenames.

Never put the natural-language query into Git arguments. It is used only by the in-memory BM25 ranker.

- [ ] **Step 5: Implement `why` evidence assembly**

Collect blame commits for a line range, path history capped at 200, exact hashes from the query, and BM25 rank over subject/body/changed paths. Select five commits, then call `git show --format=fuller --no-ext-diff --binary=false -- <path>` per selected hash with output caps. Label each reason and add limitations for shallow history, dirty lines, missing commit bodies, and clipped diffs.

- [ ] **Step 6: Run real-repository integration tests**

The test fixture must create commits with a rename, multiline message, dirty line, binary file, merge, and shallow clone. Run: `bun test packages/local-brain/src/git packages/local-brain/integration/git.test.ts`

Expected: PASS; the hostile filename/query creates no file and executes no command other than `git`.

- [ ] **Step 7: Commit Git intelligence**

```bash
git add packages/local-brain/src/git packages/local-brain/integration/git.test.ts
git commit -m "feat(brain): explain local history with Git evidence"
```

---

### Task 6: Compose local providers and expose status

**Files:**
- Create: `packages/local-brain/src/local-brain.ts`
- Create: `packages/local-brain/src/local-brain.test.ts`
- Modify: `packages/local-brain/src/index.ts`

**Interfaces:**
- Produces: `createLocalBrain(options): LocalBrain` with `identify`, `memory`, `code`, `git`, `status`, and `close`.
- Consumes: all providers from Tasks 2–5.

- [ ] **Step 1: Write failing independent-degradation tests**

```typescript
test("status retains healthy providers when CodeGraph fails", async () => {
  const brain = createLocalBrain({ memory: healthyMemory(), code: failingCode(), git: healthyGit(), identity: fixtureIdentity() });
  const status = await brain.status(repo);
  expect(status.memory.state).toBe("ready");
  expect(status.code.state).toBe("error");
  expect(status.git.state).toBe("ready");
});

test("close releases CodeGraph once", async () => {
  const code = fakeCodeProvider();
  const brain = createLocalBrain({ memory: healthyMemory(), code, git: healthyGit(), identity: fixtureIdentity() });
  await brain.close();
  await brain.close();
  expect(code.closeCalls).toBe(1);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/local-brain/src/local-brain.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement composition without formatting**

Use `Promise.allSettled` for status, map errors to stable provider codes, and never include raw error messages in logs. The `LocalBrain` object exposes structured provider APIs directly. Export the factory and types from the package entry point.

- [ ] **Step 4: Test and commit**

Run: `bun test packages/local-brain && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/local-brain/src/local-brain* packages/local-brain/src/index.ts
git commit -m "feat(brain): compose local project providers"
```

---

### Task 7: Add `wagglebot brain init`, `brain remember`, and `brain status`

**Files:**
- Create: `packages/cli/templates/component-memory.md`
- Create: `packages/cli/src/commands/brain-init.ts`
- Create: `packages/cli/src/commands/brain-init.test.ts`
- Create: `packages/cli/src/commands/brain-status.ts`
- Create: `packages/cli/src/commands/brain-status.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Produces: CLI commands `brain init [path]` and `brain status [path] [--json]`.
- Consumes: `@wagglebot/local-brain`, existing atomic-write/managed-block/report utilities.

- [ ] **Step 1: Write failing initialization tests**

```typescript
test("brain init creates memory and an owned graph ignore block once", async () => {
  const repo = await gitRepo();
  expect(await runBrainInit({ projectPath: repo, brain: fakeBrain(), reporter: quiet() })).toBe(0);
  const first = snapshotTrackedFiles(repo);
  expect(readFileSync(join(repo, ".agents/memory.md"), "utf8")).toContain("# Component Memory");
  expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".codegraph/");
  expect(await runBrainInit({ projectPath: repo, brain: fakeBrain(), reporter: quiet() })).toBe(0);
  expect(snapshotTrackedFiles(repo)).toEqual(first);
});

test("brain init never overwrites existing memory", async () => {
  const repo = await gitRepo({ memory: "# My reviewed memory\n" });
  await runBrainInit({ projectPath: repo, brain: fakeBrain(), reporter: quiet() });
  expect(readFileSync(join(repo, ".agents/memory.md"), "utf8")).toBe("# My reviewed memory\n");
});

test("brain remember previews by default and saves only with --save", async () => {
  const repo = await gitRepo({ memory: componentMemoryTemplate });
  const args = [
    "--section", "Warnings",
    "--title", "Retries duplicate charges",
    "--summary", "Check the idempotency record before retrying a timed-out charge.",
    "--evidence", "file:src/payments/charge.ts:74",
  ];
  const preview = await runBrainRemember({ projectPath: repo, args, brain: realMarkdownBrain() });
  expect(preview.stdout).toContain("### Retries duplicate charges");
  expect(readMemory(repo)).not.toContain("Retries duplicate charges");
  await runBrainRemember({ projectPath: repo, args: [...args, "--save"], brain: realMarkdownBrain() });
  expect(readMemory(repo)).toContain("Retries duplicate charges");
});
```

Add invalid existing memory, CodeGraph failure after file creation, existing
ignore rule, user content around ignore block, status JSON, no-declaration
warning, repeatable evidence, duplicate, conflict, secret rejection, and
concurrent edit cases. Assert the command has no transcript/session input and
never stages or commits the memory file.

- [ ] **Step 2: Run tests and confirm commands are absent**

Run: `bun test packages/cli/src/commands/brain-init.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add the exact memory template and non-destructive init**

Use the template in the spec. Create `.agents/` recursively, write only when the file is absent, and validate an existing file before CodeGraph initialization. Add this block only when no effective `.codegraph/` ignore rule exists:

```text
# wagglebot:begin local-brain
.codegraph/
# wagglebot:end local-brain
```

Project files are Git-backed, so D37 applies and no dry-run/backup flag is added.

- [ ] **Step 4: Implement explicit memory proposal/save CLI behavior**

Add `brain remember [path] --section <name> --title <text> --summary <text>
--evidence <kind:ref>... [--save]`. Read only these finished fields; do not add a
transcript or session-file option. Without `--save`, call `propose`, print the
action, warnings, and unified diff, and exit without a write. With `--save`,
call `propose` and immediately pass that exact proposal to `save`; print the
applied diff and new content hash. `no_change` exits successfully without a
write, while `needs_resolution`, a hash mismatch, or a scanner rejection exits
with a stable diagnostic.

- [ ] **Step 5: Implement status and command routing**

Human output uses relative paths and short HEAD. `--json` emits the full typed
status with no absolute root. Add nested help for `brain`, `brain init`, `brain
remember`, and `brain status`. Wire a `LocalBrain` factory through CLI
dependencies so unit tests do not load CodeGraph.

- [ ] **Step 6: Test and commit**

Run: `bun test packages/cli/src/commands/brain-init.test.ts packages/cli/src/commands/brain-remember.test.ts packages/cli/src/commands/brain-status.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/cli package.json bun.lock
git commit -m "feat(cli): initialize and inspect the local brain"
```

---

### Task 8: Expose low-level local MCP operations and run the milestone gate

**Files:**
- Create: `services/context-engine/package.json`
- Create: `services/context-engine/src/mcp/low-level.ts`
- Create: `services/context-engine/src/mcp/low-level.test.ts`
- Create: `services/context-engine/src/index.ts`
- Create: `services/context-engine/integration/local-e2e.test.ts`
- Modify: `packages/cli/templates/init/company/registry.yaml`
- Modify: `packages/cli/templates/AGENTS.base.md`
- Modify: matching template and registry tests
- Modify: `README.md`

**Interfaces:**
- Produces: `local_memory_search`, `brain_memory_propose`,
  `brain_memory_save`, `codegraph_explore`, `git_history`, `git_why`, and
  `local_brain_status` over stdio MCP.
- Consumes: `@wagglebot/local-brain` and `@modelcontextprotocol/sdk` 1.30.0.

- [ ] **Step 1: Write failing MCP contract tests**

```typescript
test("low-level tools require an absolute projectPath", async () => {
  const server = createLowLevelServer(fakeBrain());
  const result = await callTool(server, "git_history", { projectPath: "../repo", path: "src/a.ts" });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("absolute projectPath");
});

test("a CodeGraph failure leaves local memory available", async () => {
  const server = createLowLevelServer(brainWithFailingCode());
  expect((await callTool(server, "codegraph_explore", { projectPath: repo, query: "flow" })).isError).toBe(true);
  expect((await callTool(server, "local_memory_search", { projectPath: repo, query: "warning" })).isError).toBe(false);
});

test("a proposed chat-derived summary stays ephemeral until save", async () => {
  const server = createLowLevelServer(realMarkdownBrain(repo));
  const proposed = await callTool(server, "brain_memory_propose", proposalArgs(repo));
  expect(proposed.isError).toBe(false);
  expect(readMemory(repo)).not.toContain("Retries duplicate charges");
  const saved = await callTool(server, "brain_memory_save", proposalFrom(proposed));
  expect(saved.isError).toBe(false);
  expect(readMemory(repo)).toContain("Retries duplicate charges");
});
```

Snapshot each input/result schema and assert the exact seven tool names.
`brain_memory_propose` accepts finished fields only and exposes no transcript,
messages, prompt, or session-file property. `brain_memory_save` accepts an exact
proposal with its base hash and exposes no free-form replacement text.

- [ ] **Step 2: Create the service package and server**

```json
{
  "name": "@wagglebot/context-engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun src/index.ts", "test": "bun test" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@wagglebot/contracts": "workspace:*",
    "@wagglebot/local-brain": "workspace:*",
    "zod": "4.6.1"
  }
}
```

Register seven tools with strict schemas: `local_memory_search`,
`brain_memory_propose`, `brain_memory_save`, `codegraph_explore`, `git_history`,
`git_why`, and `local_brain_status`. Return structured provider values plus a
concise text view. The proposal result includes a reviewable diff; the save
result includes the applied diff and new hash. Map errors to stable codes;
never return stack traces or absolute roots.

- [ ] **Step 3: Add the local upstream and instruction**

Add a complete `stdio_cmd` `project-brain` entry to the company registry
template with a pinned installed command. The base instructions explain that
component memory is `.agents/memory.md`, CodeGraph is generated/local,
`git_why` is evidence, and no local source enters shared memory. They also say:

- an explicit developer “remember/save” instruction may propose and save in
  one flow;
- an agent-originated task-end/pre-compaction suggestion may call only
  `brain_memory_propose` until the developer promotes it; and
- summaries must be durable facts with evidence, never transcript excerpts,
  secrets, speculation, or current task state.

Keep the instruction under 250 words.

- [ ] **Step 4: Run the end-to-end local scenario**

The test creates a repository, runs `brain init`, records two commits, changes
one source file, starts the stdio MCP service, searches component memory,
proposes a durable learning without changing the file, explicitly saves that
proposal, searches the new learning, explores the graph, asks `git_why`,
stops/restarts the service, and repeats the graph query. Assert the saved memory
is plain Markdown, `.codegraph/codegraph.db` persists, no transcript is written,
and no network call occurs.

Run: `CODEGRAPH_TELEMETRY=0 bun test services/context-engine/integration/local-e2e.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full repository gate**

Run:

```bash
bun run check
bun run typecheck
bun test
bun run build
```

Expected: all checks PASS. Inspect `git status --short` and verify no `.codegraph/` path is listed.

- [ ] **Step 6: Commit the local milestone**

```bash
git add services/context-engine packages/cli/templates packages/cli/src README.md package.json bun.lock
git commit -m "feat(brain): expose local memory code and Git over MCP"
```

---

## Plan Completion Gate

Before starting the Unified Context Engine plan:

- `brain init` is idempotent and preserves an existing `.agents/memory.md`.
- `brain remember` previews by default, saves only with `--save`, and returns a
  reviewable diff in both modes.
- A low-level proposal makes no filesystem change; saving its exact proposal is
  atomic and fails after a concurrent memory edit.
- Duplicate, conflicting, secret-like, raw-transcript fields, or path-unsafe input
  cannot enter `.agents/memory.md`.
- CodeGraph 1.6.0 reopens its existing SQLite graph and updates a changed file incrementally.
- `git_why` returns bounded commit/blame/diff evidence and reports absent rationale as a limitation.
- BM25 ranks exact component identifiers and relevant prose deterministically.
- All seven low-level MCP operations work in a restarted process.
- Missing CodeGraph, Git, component memory, or catalog state degrades independently.
- Test capture shows no repository content or path sent over the network.
- `git status --short` contains no generated `.codegraph/` file.
