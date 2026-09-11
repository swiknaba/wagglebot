# Unified Context Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `brain_wake`, `brain_search`, `brain_explain`, and `brain_status` with progressive, non-duplicating context delivery that fuses local memory, CodeGraph, Git, and only the necessary governed shared facts.

**Architecture:** The existing local context-engine service becomes a deterministic orchestrator. New chats receive a local-only L0 envelope; continuation and task requests retrieve bounded evidence through independent providers, weighted reciprocal-rank fusion, and fixed item/token caps. A content-free cursor suppresses unchanged evidence already delivered, MCP returns prose in one representation, and shared automatic context is limited to reviewed `wake: true` facts.

**Tech Stack:** TypeScript 5.9.2, Bun, `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.6.1, `@wagglebot/contracts`, `@wagglebot/local-brain`, `@wagglebot/d26-auth`, Bun tests, Biome.

**Spec:** `docs/superpowers/specs/2026-09-11-unified-context-engine-design.md`

## Global Constraints

- Keep the context engine local and reachable through stdio or loopback only.
- Retrieval tools write no durable facts, task state, summaries, transcripts,
  graph rows, or Git caches. Preserve the dedicated local-memory proposal/save
  operations from the Local Repository Brain milestone.
- Use no LLM for planning, rewriting, ranking, conflict detection, clipping, or formatting.
- Send shared memory only the original clipped natural-language query, catalog scope names, limit, and correlation ID.
- Never send local memory, code, graph output, Git output, diffs, working-tree state, absolute paths, or fenced code to a shared service.
- Keep the existing mutation tools `propose_memory`, `remember`, and `forget`; do not reimplement them as context-engine writes.
- Use RRF with `k = 60`; never add or directly compare BM25, vector, graph, and Git raw scores.
- Every returned item has at least one evidence reference and explicit freshness.
- Preserve warnings, conflicts, exact requested evidence, and degradation notices before lower-ranked prose when applying budgets.
- L0 is the only automatic new-chat packet, is capped at 150 estimated tokens,
  returns zero retrieved items, and performs no network request.
- L1 is explicit continuation/orientation, is capped at 500 estimated tokens,
  and gives shared wake facts at most three items and 200 tokens.
- L2 and default search return at most six items, at most three from shared
  memory, and cap output at 1,500 estimated tokens.
- When supplied, cap retrieval at five percent of `remainingContextTokens`.
- Never repeat a fact's prose in MCP text and structured content.
- Cursor state holds identifiers and content hashes only: 256 entries per
  cursor, 128 cursors total, and a four-hour sliding expiry.
- Log correlation IDs, providers, counts, timings, and stable error codes only. Never log queries, content, paths, commits bodies, credentials, tokens, or raw provider errors.
- Treat the v1 tool inputs, `ContextPacket`, status result, stable errors,
  deadlines, and response limits in `docs/api-reference.md` as authoritative.
  The local service has no application requests-per-minute limit and performs
  no durable mutation.
- Run `bun run check && bun run typecheck && bun test` at every green-tree checkpoint.

---

## File Map

```text
packages/contracts/src/
  context.ts
  context.test.ts
  index.ts

services/context-engine/src/
  shared/session-token.ts
  shared/client.ts
  shared/client.test.ts
  planning/query-plan.ts
  planning/query-plan.test.ts
  retrieval/types.ts
  retrieval/adapters.ts
  retrieval/run.ts
  retrieval/run.test.ts
  ranking/rrf.ts
  ranking/rrf.test.ts
  ranking/dedupe.ts
  ranking/dedupe.test.ts
  ranking/conflicts.ts
  ranking/conflicts.test.ts
  context/cursor.ts
  context/cursor.test.ts
  context/budget.ts
  context/budget.test.ts
  context/format.ts
  context/format.test.ts
  context/wake.ts
  context/wake.test.ts
  engine.ts
  engine.test.ts
  mcp/server.ts
  mcp/server.test.ts
  mcp/representation.ts
  mcp/representation.test.ts
  mcp/low-level.ts
  index.ts
  integration/context-e2e.test.ts
  evaluation/fixtures.json
  evaluation/run.ts
  evaluation/run.test.ts

packages/cli/templates/
  AGENTS.base.md
  init/company/registry.yaml

docs/
  project-brain.md
```

The pure contracts package owns wire stability. Provider adapters turn existing source-specific results into `RetrievalCandidate`; ranking and formatting depend only on that common type. The MCP layer contains no retrieval logic.

---

### Task 1: Define context packet and evidence contracts

**Files:**
- Create: `packages/contracts/src/context.ts`
- Create: `packages/contracts/src/context.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: Zod schemas and inferred types for `ContextControls`,
  `BrainWakeInput`, `BrainSearchInput`, `BrainExplainInput`, `BrainStatusInput`,
  `EvidenceRef`, `ContextItem`, `ContextConflict`, `ProviderFailure`,
  `ContextPacket`, and the compact Markdown metadata envelope.
- Consumes: `ProjectIdentity` is represented as a contracts-layer wire type rather than imported from local-brain, avoiding a dependency cycle.

- [ ] **Step 1: Write failing contract tests**

```typescript
test("every context item requires evidence and freshness", () => {
  const result = ContextItemSchema.safeParse({
    id: "code:TokenService",
    source: "code",
    kind: "symbol",
    title: "TokenService.rotate",
    excerpt: "rotate()",
    provenance: [],
    freshness: "live",
    channelRanks: { code_exact: 1 },
    fusedScore: 0.02,
    authorityTier: 100,
  });
  expect(result.success).toBe(false);
});

test("tool inputs reject relative paths and excessive budgets", () => {
  expect(BrainWakeInputSchema.safeParse({ projectPath: "../repo", level: 1 }).success).toBe(false);
  expect(BrainSearchInputSchema.safeParse({ projectPath: "/repo", query: "x", maxTokens: 5001 }).success).toBe(false);
});

test("context controls accept a cursor and remaining-context hint", () => {
  expect(BrainSearchInputSchema.parse({
    projectPath: "/repo",
    query: "token rotation",
    cursor: "ctx_0123456789abcdef",
    remainingContextTokens: 20_000,
    responseFormat: "markdown",
  })).toBeDefined();
});
```

Add strict-object unknown-key, line-range pairing, query/task length, source
enum, per-mode token maximum, remaining-context lower bound, response format,
cursor length/shape, limit, timestamp, full commit SHA, packet ID, cursor,
effective budget, omission reason, and packet-size field tests. Assert packet
items use `excerpt` and have no `markdown` field. Include `cursor_reset` in the
omission enum.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test packages/contracts/src/context.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement strict schemas and exports**

```typescript
export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_memory"), path: z.literal(".agents/memory.md"), startLine: z.number().int().positive(), endLine: z.number().int().positive(), contentHash: Sha256Schema }).strict(),
  z.object({ kind: z.literal("code"), path: RelativePathSchema, startLine: z.number().int().positive(), endLine: z.number().int().positive(), symbol: z.string().optional(), graphState: z.enum(["ready", "pending", "stale"]) }).strict(),
  z.object({ kind: z.literal("git"), commit: GitShaSchema, path: RelativePathSchema.optional(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal("shared_memory"), memoryId: z.string().uuid(), repository: z.string().optional(), path: RelativePathSchema.optional(), commitSha: GitShaSchema.optional(), heading: z.string().optional() }).strict(),
]);
```

Use `.min(1)` for provenance and `.finite()` for scores. Refine line ranges so
end is at least start. Define the mode hard maxima from the spec in one exported
constant and refine each input against its mode. Export all schemas/types from
the package entry point.

- [ ] **Step 4: Test and commit**

Run: `bun test packages/contracts/src/context.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/contracts/src/context* packages/contracts/src/index.ts
git commit -m "feat(context): define evidence-bearing context packets"
```

---

### Task 2: Add a private shared-memory client with D26 token reuse

**Files:**
- Create: `services/context-engine/src/shared/session-token.ts`
- Create: `services/context-engine/src/shared/session-token.test.ts`
- Create: `services/context-engine/src/shared/client.ts`
- Create: `services/context-engine/src/shared/client.test.ts`

**Interfaces:**
- Consumes: the shared worker's `POST /v1/memory/search`; `D26Client`/`SessionTokenProvider` from `@wagglebot/d26-auth`, configured for the `wagglebot-memory` audience.
- Produces: `SharedMemoryClient.search(input, signal)`, `.wake(input, signal)`,
  and `.status(signal)`.

- [ ] **Step 1: Write failing token-cache and privacy tests**

```typescript
test("uses the D26 client cache until one minute before expiry", async () => {
  const client = fakeD26Client(expiresInMinutes(10));
  await client.get("wagglebot-memory", AbortSignal.timeout(100));
  await client.get("wagglebot-memory", AbortSignal.timeout(100));
  expect(client.issueCalls).toBe(1);
});

test("shared request contains no local candidates or working-tree state", async () => {
  const fetch = recordingFetch(searchResponse());
  const client = new HttpSharedMemoryClient(config(), tokens(), fetch);
  await client.search({
    purpose: "query",
    query: "how does token rotation work",
    cascade: { system: "payments", domain: "finance", includeOrg: true },
    limit: 20,
  }, AbortSignal.timeout(100));
  const sent = JSON.stringify(fetch.requests[0]?.body);
  expect(sent).toBe('{"purpose":"query","query":"how does token rotation work","cascade":{"system":"payments","domain":"finance","includeOrg":true},"limit":20}');
});

test("wake sends no query and requests at most three reviewed facts", async () => {
  const fetch = recordingFetch(wakeResponse());
  const client = new HttpSharedMemoryClient(config(), tokens(), fetch);
  await client.wake({
    purpose: "wake",
    cascade: { system: "payments", domain: "finance", includeOrg: true },
    limit: 3,
  }, AbortSignal.timeout(100));
  expect(fetch.requests[0]?.body).toEqual({
    purpose: "wake",
    cascade: { system: "payments", domain: "finance", includeOrg: true },
    limit: 3,
  });
});
```

Add one retry after 401, no retry after 403, expired token, invalid response
schema, timeout, fenced code, high entropy, scanner match, query clipping, wake
limit, and wake response eligibility-field cases.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test services/context-engine/src/shared`

Expected: FAIL.

- [ ] **Step 3: Wire the D26 client without duplicating authentication**

Import `D26Client` and `SessionTokenProvider` from `@wagglebot/d26-auth` and
inject the client into `HttpSharedMemoryClient`. Keep
`services/context-engine/src/shared/session-token.ts` as a narrow adapter or
re-export only; it must not contain a second challenge, SSH signature, JWT
verification, or token-cache implementation. The D26 plan owns those behaviors
and its tests are the source of truth.

- [ ] **Step 4: Implement guarded search**

For `search`, reject shared transmission when the query has a fenced code block,
scanner match, or a token-like run with high entropy. Clip to 2,000 Unicode code
points. For `wake`, accept only the resolved cascade and limit 1–3; construct no
query field. Send only contract fields. Use a fixed `User-Agent` version, bearer
header, and correlation header. Validate response JSON before returning.

On 401, invalidate and reacquire once. On timeout/provider/schema failure, throw a stable `SharedProviderError` that contains no body, URL credentials, or token.

- [ ] **Step 5: Test and commit**

Run: `bun test services/context-engine/src/shared && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/shared
git commit -m "feat(context): query governed shared memory privately"
```

---

### Task 3: Implement deterministic query planning and provider adapters

**Files:**
- Create: `services/context-engine/src/planning/query-plan.ts`
- Create: `services/context-engine/src/planning/query-plan.test.ts`
- Create: `services/context-engine/src/retrieval/types.ts`
- Create: `services/context-engine/src/retrieval/adapters.ts`
- Create: `services/context-engine/src/retrieval/adapters.test.ts`

**Interfaces:**
- Produces: `planQuery(input): QueryPlan`, common `RetrievalCandidate`, and adapters for local-memory, CodeGraph, Git, and shared-memory results.
- Consumes: contracts and structured provider results; no rendered Markdown.

- [ ] **Step 1: Write table-driven planner tests**

```typescript
test.each([
  ["why did TokenService.rotate change", ["local_memory", "code", "git"]],
  ["company API compatibility policy", ["local_memory", "shared_memory"]],
  ["what calls src/auth/rotate.ts", ["local_memory", "code"]],
  ["history of commit abc1234", ["local_memory", "git"]],
])("plans %s", (query, expected) => {
  expect(planQuery({ mode: "search", query }).providers).toEqual(expected);
});

test("L0 selects identity status only and never a provider", () => {
  expect(planQuery({ mode: "wake", level: 0 }).providers).toEqual([]);
});

test("L1 uses the dedicated shared wake channel", () => {
  expect(planQuery({ mode: "wake", level: 1 }).sharedPurpose).toBe("wake");
});

test("an explicit source list wins", () => {
  expect(planQuery({ mode: "search", query: "why", sources: ["shared_memory"] }).providers).toEqual(["shared_memory"]);
});
```

Add L0/L1/L2/L3 and explain-mode tables.

- [ ] **Step 2: Write adapter provenance tests**

```typescript
test("CodeGraph adapter maps repository-relative line evidence", () => {
  const candidate = adaptCodeGraph(codeResult({ absolutePath: join(repo, "src/a.ts"), line: 7 }), repo)[0];
  expect(candidate.provenance).toEqual([{ kind: "code", path: "src/a.ts", startLine: 7, endLine: 14, symbol: "a", graphState: "ready" }]);
});
```

Add local-memory, Git, shared provenance, stale CodeGraph, inactive shared hit rejection, and absolute-path stripping tests.

- [ ] **Step 3: Run tests and confirm failure**

Run: `bun test services/context-engine/src/planning services/context-engine/src/retrieval/adapters.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement query planning**

Tokenize with the local-brain tokenizer. Match exact lowercased terms,
commit-hash patterns, path separators/extensions, line ranges, and identifier
shapes. L0 selects no retrieval provider. L1 selects bounded local memory, Git
titles, and the shared `wake` purpose without a text query. L2/L3 use the task
planner. Search/explain select local memory unless the caller supplies another
explicit source list. Select providers in the stable order `local_memory`,
`code`, `git`, `shared_memory` so snapshots do not depend on set order.

- [ ] **Step 5: Implement source adapters**

Every adapter sets source, kind, title, content, evidence, freshness, channel name/rank, authority tier, stable ID, optional scope, identity key, and content hash. Reject a candidate without evidence before it enters retrieval. Convert absolute CodeGraph paths to validated repository-relative paths.

- [ ] **Step 6: Test and commit**

Run: `bun test services/context-engine/src/planning services/context-engine/src/retrieval/adapters.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/planning services/context-engine/src/retrieval
git commit -m "feat(context): plan and normalize context retrieval"
```

---

### Task 4: Run providers concurrently with independent deadlines

**Files:**
- Create: `services/context-engine/src/retrieval/run.ts`
- Create: `services/context-engine/src/retrieval/run.test.ts`

**Interfaces:**
- Produces: `runRetrieval(plan, request, providers, clock): Promise<RetrievalRun>`.
- Consumes: `QueryPlan`, provider adapters, local brain, and shared client.

- [ ] **Step 1: Write failing fake-clock tests**

```typescript
test("returns healthy candidates when Git times out", async () => {
  const run = await runRetrieval(planAll(), request(), providers({
    local_memory: immediate([localCandidate()]),
    code: immediate([codeCandidate()]),
    git: neverResolves(),
    shared_memory: immediate([sharedCandidate()]),
  }), fakeClock());
  expect(run.candidates.map((x) => x.source)).toEqual(["local_memory", "code", "shared_memory"]);
  expect(run.failures).toContainEqual(expect.objectContaining({ provider: "git", code: "timeout" }));
});

test("ignores a response that arrives after its provider deadline", async () => {
  const late = controllableProvider();
  const promise = runRetrieval(planOnly("code"), request(), providers({ code: late }), fakeClock());
  late.advancePastDeadline();
  late.resolve([codeCandidate()]);
  expect((await promise).candidates).toEqual([]);
});
```

Add per-mode aggregate deadline, abort propagation, provider cap, exception mapping, missing catalog/shared cascade, and timing diagnostics tests.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test services/context-engine/src/retrieval/run.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement abortable parallel retrieval**

Create one child `AbortController` per provider, tie it to the caller signal,
and schedule its deadline. Start all provider promises before awaiting any. Use
`Promise.allSettled`, clear timers in `finally`, and discard results after a
deadline flag is set.

```typescript
const settled = await Promise.allSettled(selected.map((provider) => runOne(provider, request, limits[provider], parentSignal)));
```

Map failures to `{ provider, code, elapsedMs }` with stable codes `timeout`, `missing`, `invalid_response`, `unauthorized`, `unavailable`, or `internal`. Do not include raw messages.

- [ ] **Step 4: Test and commit**

Run: `bun test services/context-engine/src/retrieval/run.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/retrieval/run*
git commit -m "feat(context): retrieve context with bounded degradation"
```

---

### Task 5: Fuse ranks, deduplicate evidence, suppress repeats, and surface conflicts

**Files:**
- Create: `services/context-engine/src/ranking/rrf.ts`
- Create: `services/context-engine/src/ranking/rrf.test.ts`
- Create: `services/context-engine/src/ranking/dedupe.ts`
- Create: `services/context-engine/src/ranking/dedupe.test.ts`
- Create: `services/context-engine/src/ranking/conflicts.ts`
- Create: `services/context-engine/src/ranking/conflicts.test.ts`
- Create: `services/context-engine/src/context/cursor.ts`
- Create: `services/context-engine/src/context/cursor.test.ts`

**Interfaces:**
- Produces: `fuseCandidates`, `dedupeCandidates`, `detectConflicts`, and a
  bounded `ContextCursorStore` that filters unchanged evidence already sent in
  the current chat.
- Consumes: normalized `RetrievalCandidate[]` only.

- [ ] **Step 1: Write failing RRF tests**

```typescript
test("uses rank and weight without adding raw scores", () => {
  const fused = fuseCandidates([
    candidate("same", "code_exact", 1, { rawScore: 0.01 }),
    candidate("same", "shared_semantic", 2, { rawScore: 0.99 }),
  ]);
  expect(fused[0]?.fusedScore).toBeCloseTo(1.4 / 61 + 1.0 / 62, 10);
});

test("stable id breaks a complete tie", () => {
  expect(fuseCandidates([candidate("b", "shared_lexical", 1), candidate("a", "shared_lexical", 1)]).map((x) => x.id)).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Write dedupe and conflict tests**

```typescript
test("same text in component and system keeps component specificity and both provenance refs", () => {
  const result = dedupeCandidates([sameText("component"), sameText("system")]);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.scope).toBe("component");
  expect(result.items[0]?.provenance).toHaveLength(2);
});

test("current source and old memory produce a visible resolved conflict", () => {
  const conflicts = detectConflicts([currentCode("runtime", "node22"), oldMemory("runtime", "node20")]);
  expect(conflicts).toEqual([expect.objectContaining({ resolution: "current_source_preferred" })]);
});
```

Add same provider ID, same locator/hash, superseded memory, reviewed Git over old derived record, component over broader rule, unresolved equal-authority values, and no semantic-only dedupe cases.

- [ ] **Step 3: Write cursor lifecycle tests**

```typescript
test("suppresses unchanged evidence and returns a changed hash", () => {
  const store = new ContextCursorStore({ now, randomId });
  const cursor = store.commit(store.open(undefined), [item("fact-1", "hash-a")]);
  expect(store.filter(store.open(cursor), [item("fact-1", "hash-a")]).items).toEqual([]);
  expect(store.filter(store.open(cursor), [item("fact-1", "hash-b")]).items).toHaveLength(1);
});

test("cursor state contains identifiers and hashes only and expires", () => {
  const store = new ContextCursorStore({ now, randomId });
  const cursor = store.commit(store.open(undefined), [item("fact-1", "hash-a", "secret prose")]);
  expect(store.inspectForTest(cursor)).toEqual([{ id: "fact-1", contentHash: "hash-a" }]);
  now.advance({ hours: 4, milliseconds: 1 });
  expect(store.open(cursor).reset).toBe(true);
});
```

Add unknown/invalid cursor, 256-entry eviction, 128-cursor LRU eviction,
four-hour sliding expiry, changed evidence, and process-restart reset cases.
Conflict and degradation records are packet metadata and are never removed by
evidence repeat suppression.

- [ ] **Step 4: Run tests and confirm failure**

Run: `bun test services/context-engine/src/ranking services/context-engine/src/context/cursor.test.ts`

Expected: FAIL.

- [ ] **Step 5: Implement weighted RRF and tie-breaks**

Use the exact weights from the spec and `k = 60`. Merge channel ranks by candidate ID. Sort by fused score, exact match, authority tier, scope specificity, authoritative revision time, then stable ID. Keep raw scores only under debug diagnostics.

- [ ] **Step 6: Implement evidence-based dedupe/conflicts**

Normalize content for hashing without changing returned text. Dedupe only by stable ID, locator+hash, normalized content, or explicit supersession. Detect conflicts only when candidates share an `identityKey` or one explicitly supersedes/cites the other's source. Return both unresolved candidates.

- [ ] **Step 7: Implement bounded cursor state**

Generate opaque random cursor IDs. Store only stable evidence IDs and content
hashes in an in-process LRU map: at most 256 pairs per cursor, 128 cursors, and
a four-hour sliding TTL. `open` treats missing, unknown, expired, or invalid
cursors as a reset; `filter` removes only matching ID/hash pairs and reports an
`already_delivered` omission count; `commit` merges only the items actually
selected for the packet. Inject the clock and ID generator for deterministic
tests. Do not persist cursor state or put queries, prose, paths, users, or
credentials in it.

- [ ] **Step 8: Test and commit**

Run: `bun test services/context-engine/src/ranking services/context-engine/src/context/cursor.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/ranking services/context-engine/src/context/cursor*
git commit -m "feat(context): rank evidence and suppress delivered context"
```

---

### Task 6: Apply budgets and render stable Markdown

**Files:**
- Create: `services/context-engine/src/context/budget.ts`
- Create: `services/context-engine/src/context/budget.test.ts`
- Create: `services/context-engine/src/context/format.ts`
- Create: `services/context-engine/src/context/format.test.ts`

**Interfaces:**
- Produces: `estimateTokens`, `selectWithinBudget`, and `formatContextPacket`.
- Consumes: fused items, conflicts, provider failures, project/freshness metadata.

- [ ] **Step 1: Write failing budget-priority tests**

```typescript
test("keeps warnings and exact requested evidence before lower-ranked prose", () => {
  const selected = selectWithinBudget({
    maxTokens: 120,
    required: [warningItem(), exactLineItem()],
    ranked: [longSharedItem(), shortLocalItem()],
  });
  expect(selected.items.map((x) => x.id)).toEqual([warningItem().id, exactLineItem().id]);
  expect(selected.omitted.reasons).toContain("budget");
});

test("estimates tokens conservatively by Unicode code points", () => {
  expect(estimateTokens("abcdefgh")).toBe(3);
  expect(estimateTokens("😀😀😀😀")).toBe(2);
});
```

Add mode defaults/hard maxima, the five-percent `remainingContextTokens` cap,
the 16-KiB serialization cap, per-mode item limits, the L1 shared sub-budget,
paragraph clipping, fenced-code atomic clipping, handle preservation, and
empty/degraded packet cases. Assert L0 is 100/150, L1 is 350/500, L2 and search
are 800/1,500, L3 is 3,000/5,000, and explain is 1,200/2,500
(default/hard maximum). Measure the combined model-visible MCP text and
structured content for the chosen response format, including the compact
metadata envelope.

- [ ] **Step 2: Write formatter snapshot tests**

Build one packet containing identity, stale graph, conflict, code, Git, local, shared, degraded provider, and handles. Snapshot the exact heading order and assert that empty sections are absent. Assert no internal score appears in Markdown.

- [ ] **Step 3: Run tests and confirm failure**

Run: `bun test services/context-engine/src/context/budget.test.ts services/context-engine/src/context/format.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement budget selection**

Estimate `ceil([...text].length / 3)`. Start from the caller's `maxTokens` when
supplied, otherwise the mode default; clamp it to the mode hard maximum, then
also cap it at five percent of `remainingContextTokens` when supplied. Reserve
identity/freshness, conflicts/warnings, exact request evidence, and footer space
before ranked items. Apply item and source caps before token selection: zero
items for L0; at most three shared facts and 200 shared tokens for L1; at most
six items and three shared items for L2/search. Clip only at paragraph or
complete code-fence boundaries and append `[content clipped]`. Re-run
estimation after formatting and remove the last optional item until both the
effective token budget and 16-KiB serialized limit pass.

- [ ] **Step 5: Implement fixed Markdown formatting**

Render in this order: identity/freshness, warnings/conflicts, current code, why/history, component memory, shared context, degraded sources, handles. Escape control characters and unsafe Markdown link destinations. Use repository-relative paths and short display hashes while keeping full hashes in structured provenance.

- [ ] **Step 6: Test and commit**

Run: `bun test services/context-engine/src/context && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/context
git commit -m "feat(context): budget and format project context"
```

---

### Task 7: Build wake modes and the context engine facade

**Files:**
- Create: `services/context-engine/src/context/wake.ts`
- Create: `services/context-engine/src/context/wake.test.ts`
- Create: `services/context-engine/src/engine.ts`
- Create: `services/context-engine/src/engine.test.ts`

**Interfaces:**
- Produces: `ContextEngine.wake`, `.search`, `.explain`, and `.status`.
- Consumes: project identity, query planner, retrieval runner, ranking, conflicts, budgets, formatter, local brain, and shared client.

- [ ] **Step 1: Write failing wake-level tests**

```typescript
test("L0 performs no code or network retrieval", async () => {
  const providers = recordingProviders();
  const packet = await engine(providers).wake({ projectPath: repo, level: 0 });
  expect(providers.calls).toEqual(["identity", "git_status"]);
  expect(packet.items).toEqual([]);
  expect(packet.estimatedTokens).toBeLessThanOrEqual(150);
});

test("L1 returns a bounded orientation packet and reviewed shared wake facts", async () => {
  const providers = recordingProviders();
  const packet = await engine(providers).wake({ projectPath: repo, level: 1 });
  expect(providers.sharedRequests[0]).toEqual(expect.objectContaining({ purpose: "wake", limit: 3 }));
  expect(packet.items.filter((item) => item.source === "shared_memory").length).toBeLessThanOrEqual(3);
  expect(sharedTokenCount(packet)).toBeLessThanOrEqual(200);
  expect(packet.estimatedTokens).toBeLessThanOrEqual(500);
});

test("L2 requires and uses a task", async () => {
  await expect(engine().wake({ projectPath: repo, level: 2 })).rejects.toThrow(/task/);
  const packet = await engine().wake({ projectPath: repo, level: 2, task: "fix TokenService rotation" });
  expect(packet.request.task).toBe("fix TokenService rotation");
  expect(packet.items.some((x) => x.source === "code")).toBe(true);
});
```

Add L1's 200-token shared sub-budget and three-title Git limit, L3 explicit
request, L2/search six-item and three-shared-item caps, caller-selected budget,
five-percent remaining-context cap, hard cap, no declaration/org-only cascade,
dirty tree, missing provider, low-relevance omission, and shared wake eligibility
cases.

- [ ] **Step 2: Write search/explain/status facade tests**

```typescript
test("explain always requests code and Git", async () => {
  const providers = recordingProviders();
  await engine(providers).explain({ projectPath: repo, symbol: "TokenService.rotate" });
  expect(providers.calls).toContain("code");
  expect(providers.calls).toContain("git");
});

test("engine never calls a memory mutation", async () => {
  const shared = readOnlySharedClient();
  await engine({ shared }).search({ projectPath: repo, query: "policy" });
  expect(shared.mutationCalls).toBe(0);
});

test("reusing a cursor omits unchanged evidence and returns changed evidence", async () => {
  const first = await engine().search({ projectPath: repo, query: "policy" });
  const repeated = await engine().search({ projectPath: repo, query: "policy", cursor: first.cursor });
  expect(repeated.items).toEqual([]);
  expect(repeated.omitted.reasons).toContain("already_delivered");
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run: `bun test services/context-engine/src/context/wake.test.ts services/context-engine/src/engine.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the common pipeline**

```typescript
private async build(mode: Mode, input: BrainInput, signal: AbortSignal): Promise<ContextPacket> {
  const project = await this.local.identify(input.projectPath);
  const plan = planQuery({ mode, ...input });
  const run = await runRetrieval(plan, { ...input, project }, this.providers, this.clock, signal);
  const deduped = dedupeCandidates(run.candidates);
  const ranked = fuseCandidates(deduped.items);
  const conflicts = detectConflicts(ranked);
  const delivery = this.cursors.open(input.cursor);
  const unseen = this.cursors.filter(delivery, ranked);
  const packet = buildPacket({ mode, input, project, run, ranked: unseen.items, conflicts });
  packet.cursor = this.cursors.commit(delivery, packet.items);
  return packet;
}
```

L0 uses the dedicated identity/status path and produces no retrieval items. L1
is called only for explicit continuation/orientation, reads bounded local
purpose/warnings/decisions, includes at most three recent Git subject lines,
calls the PostgreSQL-only shared `wake` channel without a query, and reports
CodeGraph status without source context. It returns at most three wake-eligible
shared facts within 200 shared tokens. L2/L3 use the task planner. Search and L2
return at most six items, including at most three shared items. Apply conflict
detection before cursor filtering so a conflict cannot disappear merely because
one evidence item was already delivered. Commit only evidence serialized in the
current packet. `status` calls content-free provider status methods only.

- [ ] **Step 5: Enforce one-way privacy in the facade**

Build the shared request before any local candidate is fetched, using only the validated input query/task and project system/domain names. Freeze the request object in development tests and assert local adapters cannot mutate it.

- [ ] **Step 6: Test and commit**

Run: `bun test services/context-engine/src/context/wake.test.ts services/context-engine/src/engine.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/context/wake* services/context-engine/src/engine*
git commit -m "feat(context): assemble wake search and explain packets"
```

---

### Task 8: Expose the four `brain_*` MCP tools and preserve diagnostics

**Files:**
- Create: `services/context-engine/src/mcp/server.ts`
- Create: `services/context-engine/src/mcp/server.test.ts`
- Create: `services/context-engine/src/mcp/representation.ts`
- Create: `services/context-engine/src/mcp/representation.test.ts`
- Modify: `services/context-engine/src/mcp/low-level.ts`
- Modify: `services/context-engine/src/index.ts`
- Modify: `services/context-engine/package.json`

**Interfaces:**
- Produces: `brain_wake`, `brain_search`, `brain_explain`, and `brain_status`;
  retains all seven low-level local operations, including
  `brain_memory_propose` and `brain_memory_save`, for CodeMode execution.
- Consumes: `ContextEngine` and the contracts schemas.

- [ ] **Step 1: Write failing MCP surface tests**

```typescript
test("recommended surface contains exactly four brain tools", async () => {
  const catalog = await listRecommendedTools(createServer(fixtureEngine()));
  expect(catalog.map((x) => x.name).sort()).toEqual(["brain_explain", "brain_search", "brain_status", "brain_wake"]);
});

test("Markdown mode puts fact prose in MCP text only", async () => {
  const result = await callTool(createServer(fixtureEngine()), "brain_search", {
    projectPath: repo,
    query: "token rotation",
    responseFormat: "markdown",
  });
  expect(result.structuredContent.schemaVersion).toBe(1);
  expect(result.content[0]?.text).toContain("Rotation is transactional");
  expect(JSON.stringify(result.structuredContent)).not.toContain("Rotation is transactional");
});

test("structured mode puts fact prose in structured content only", async () => {
  const result = await callTool(createServer(fixtureEngine()), "brain_search", {
    projectPath: repo,
    query: "token rotation",
    responseFormat: "structured",
  });
  expect(result.structuredContent.items[0]?.excerpt).toContain("Rotation is transactional");
  expect(result.content[0]?.text).not.toContain("Rotation is transactional");
});
```

Add schema rejection, abort-on-disconnect, internal-error mapping, 16-KiB cap,
metadata-envelope validation, and no stack/raw-error tests. Serialize each
fixture result and assert no title or excerpt occurs in both MCP representations.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test services/context-engine/src/mcp/server.test.ts`

Expected: FAIL.

- [ ] **Step 3: Register the tool handlers**

Use the shared contract schemas as the source for input validation. One handler
calls one engine method and passes the packet through `toMcpResult`. In
`markdown` mode, MCP `content` contains the rendered packet while
`structuredContent` contains only schema version, packet/cursor IDs, budget and
omission counts, failure codes, evidence handles, and conflict item IDs plus
resolution codes; it contains no item title, excerpt, or conflict reason. In
`structured` mode, `structuredContent` contains the packet items and excerpts
while MCP text contains only a one-line count/budget summary.
Estimate the combined text and structured content, then drop the last optional
item and rerender until both the effective token budget and 16-KiB serialized
cap pass.
Convert known errors to fixed user-safe messages; record only stable codes in
logs.

Keep low-level provider tools registered in the service's complete capability set. Mark only the four `brain_*` tools recommended in server instructions so the local hub's catalog/CodeMode can expose a small normal surface.

- [ ] **Step 4: Wire runtime and shutdown**

Construct local brain, D26 token provider, shared client, and engine from validated non-secret config. Start the stdio server. On EOF, SIGTERM, or SIGINT, abort active requests and call `localBrain.close()` once.

- [ ] **Step 5: Test and commit**

Run: `bun test services/context-engine/src/mcp && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/context-engine/src/mcp services/context-engine/src/index.ts services/context-engine/package.json bun.lock
git commit -m "feat(context): expose the unified project brain over MCP"
```

---

### Task 9: Install the protocol, evaluation fixture, and end-to-end gate

**Files:**
- Modify: `packages/cli/templates/AGENTS.base.md`
- Modify: template tests
- Modify: `packages/cli/templates/init/company/registry.yaml`
- Modify: registry/scaffold tests
- Create: `services/context-engine/evaluation/fixtures.json`
- Create: `services/context-engine/evaluation/run.ts`
- Create: `services/context-engine/evaluation/run.test.ts`
- Create: `services/context-engine/integration/context-e2e.test.ts`
- Create: `docs/project-brain.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: installed project-brain behavior, reproducible retrieval evaluation, user/operation docs, and Phase 2 memory end-to-end proof.
- Consumes: both earlier milestones and all context-engine tasks.

- [ ] **Step 1: Write failing template and registry tests**

```typescript
test("base instructions teach the four invariant context rules", () => {
  const text = renderBaseTemplate();
  expect(text).toContain("new chat");
  expect(text).toContain("L0");
  expect(text).toContain("Use L1 only");
  expect(text).toContain("context cursor");
  expect(text).toContain("current source");
  expect(text).toContain("`.agents/memory.md`");
  expect(text).toContain("Never save transcripts");
  expect(text).toContain("`brain_memory_propose`");
  expect(text).toContain("explicitly says to remember");
  expect(text).toContain("until the developer says save, remember, or promote");
});

test("company registry launches one pinned local context engine", () => {
  const entry = loadRegistryTemplate().find((x) => x.namespace === "project-brain");
  expect(entry?.mode).toBe("stdio_cmd");
  expect(entry?.command).toMatch(/wagglebot-context-engine/);
  expect(entry?.env?.CODEGRAPH_TELEMETRY).toBe("0");
});
```

- [ ] **Step 2: Add the concise base protocol and registry entry**

Add the exact protocol from the spec, kept below 250 words. It instructs a new
chat to call L0 only; permits L1 only for an explicit continue/orientation
request; uses L2 directly when a concrete task is known; passes the latest
context cursor to later calls; and follows evidence handles for detail instead
of requesting a larger packet. It distinguishes an explicit developer remember
request, which may propose and save in one flow, from an agent-originated
suggestion, which must remain a proposal until the developer promotes it. The
registry entry names a version-pinned installed executable and D26/shared-memory
endpoint environment references without literal secrets. Preserve all Phase 1
instructions and registry entries.

- [ ] **Step 3: Build the retrieval evaluation fixture**

Create at least 50 approved synthetic/public questions. Each record has:

```json
{
  "id": "git-why-001",
  "mode": "explain",
  "input": { "query": "why is token rotation transactional", "path": "src/token.ts", "startLine": 12, "endLine": 18 },
  "acceptableEvidenceIds": ["git:1111111111111111111111111111111111111111", "code:TokenService.rotate"],
  "requiredSources": ["code", "git"],
  "requiredConflict": false
}
```

Cover exact symbols/paths/hashes, architecture flow, local warnings, system conventions, org interfaces, stale graph, superseded source, explicit conflict, provider timeout, and budget pressure. Do not include private company source or knowledge.

- [ ] **Step 4: Implement evaluation metrics and thresholds**

Calculate evidence recall at 5, exact-identifier recall, provenance completeness,
explicit-conflict precision/recall, all mode token/item-cap compliance, shared
L1 sub-budget compliance, cursor repeat suppression, single-representation prose,
degradation success, and captured shared-request leakage. Fail below the exact
thresholds in the spec. Print record IDs and metric counts only; never print
fixture content from a failing case.

- [ ] **Step 5: Run the end-to-end Phase 2 memory scenario**

The integration test must:

```text
1. create two component repositories in one system and one component in another system;
2. initialize CodeGraph and component memory in all three;
3. create Git history with a documented decision and a later code change;
4. publish one system fact, one domain convention, and one org interface;
5. call L0 from a fresh context-engine process and prove it returns no retrieved
   items and makes no shared, CodeGraph-content, or memory retrieval call;
6. call L1 explicitly and prove it returns no more than three active,
   high-confidence, unexpired `wake: true` shared facts within 200 shared tokens;
7. call search for a cross-repository convention and prove the whole packet has
   no more than six items and three shared items;
8. repeat search with its cursor and prove unchanged evidence prose is absent;
9. change one selected fact, repeat with the cursor, and prove the changed fact
   returns;
10. call explain for a changed symbol;
11. prove another component never receives the first component's memory;
12. make CodeGraph pending and prove the stale marker;
13. stop shared memory and prove local wake/search/explain still work;
14. restart both local and shared processes, prove durable indexes/memory
    persist, and prove the old ephemeral cursor resets safely;
15. capture outbound shared requests and prove they contain no local provider
    payload;
16. inspect both MCP response modes and prove each fact's prose appears in one
    representation only.
```

Use signed fixture D26 tokens and the pinned MemPalace/PostgreSQL test stack. Expected: PASS.

- [ ] **Step 6: Document use and operations**

`docs/project-brain.md` explains initialization, the one-time CodeGraph build,
incremental updates, local/shared boundaries, manual memory editing, explicit
remember, agent suggestion and promotion, the four recommended retrieval tools,
the two local-memory write tools, progressive wake levels, token/item caps,
reviewed shared wake facts, response representations, cursor reuse, evidence
handles, shared service degradation, status output, reindexing, and the exact
data that leaves the workstation. Explain that detailed evidence is fetched by
handle only when the task needs it. Include one end-to-end example that distills
a durable fact from an active chat, previews its Markdown diff, promotes it, and
finds it in a later session without retaining the chat. Use no private company
names or content.

- [ ] **Step 7: Add CI gates and run verification**

CI runs unit tests on every change, PostgreSQL/MemPalace contracts on service changes, CodeGraph compatibility on local-brain changes, evaluation on ranking/formatting changes, and full end-to-end on the release branch.

Run:

```bash
bun run check
bun run typecheck
bun test
bun run build
CODEGRAPH_TELEMETRY=0 bun test services/context-engine/evaluation/run.test.ts
```

Then run the documented container-backed end-to-end test. Expected: all checks PASS and all evaluation thresholds meet the spec.

- [ ] **Step 8: Commit the completed context engine**

```bash
git add packages/cli/templates services/context-engine/evaluation services/context-engine/integration docs/project-brain.md README.md .github/workflows/ci.yml
git commit -m "feat(context): deliver evidence-backed project wake and search"
```

---

## Plan Completion Gate

Phase 2 memory is complete only when:

- L0/L1/L2/L3, search, explain, and status pass their deterministic budgets and schemas.
- L0 is the only automatic new-chat packet, returns zero retrieved items, makes
  no network request, and stays at or below 150 estimated tokens.
- L1 is explicit, stays at or below 500 estimated tokens, and includes no more
  than three eligible shared wake facts within 200 shared tokens.
- L2 and default search stay at or below 1,500 estimated tokens and return at
  most six items, including no more than three shared items.
- Every returned item has a resolvable evidence reference and explicit freshness.
- RRF uses only channel rank and fixed weight; raw scores do not affect cross-channel ordering.
- Explicit conflicts remain visible and current/reviewed sources receive the documented resolution.
- A local provider and the shared provider can each fail independently while healthy evidence remains usable.
- Another component never receives repository-local `.agents/memory.md` content.
- Captured shared requests contain only query/task text, catalog scopes, result limit, and correlation ID.
- No test capture or log contains code, graph output, Git content, local memory, shared memory text, credentials, DSNs, or absolute paths.
- The 50-question evaluation meets every release threshold.
- Reusing a cursor removes unchanged fact prose, returns changed evidence, and
  stores no queries, content, paths, users, or credentials.
- Every MCP result includes each returned fact's prose in exactly one response
  representation and stays within the 16-KiB serialized cap.
- A completely new context-engine process reopens the existing CodeGraph index and retrieves the persisted shared memory after restart.
