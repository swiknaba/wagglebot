# Phase 2 Implementation Sequence

> **Partially historical.** For the shared-memory milestone, follow
> [the 2026-09-16 Sequel plan](2026-09-16-sequel-shared-memory-foundation.md)
> and the current 2026-08-28 shared-layer, service-contract, and Phase 4
> specifications. Historical steps below remain as a record of completed work;
> active shared-memory requirements use the single-table Sequel design.

> **Local-memory amendment (2026-09-26):** The unshipped single-file memory
> implementation is a historical checkpoint. Task 1A and the
> [OKF local-memory design](../specs/2026-09-26-okf-local-memory-design.md)
> replace it before the Unified Context Engine begins.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Wagglebot Phase 2 as a local-first repository brain plus authenticated, governed shared services and bounded context transfer, while preserving the Phase 1 provisioning contract and keeping source code, component memory, and workstation credentials local.

**Architecture:** Phase 2 is six testable milestones connected by explicit dependency gates. Local repository intelligence is built first; SSH authentication then supplies shared-service identity; the authenticated registry and local MCP hub provide governed tool access; shared memory stores only system/domain/organization knowledge; the unified context engine fuses bounded local and shared evidence; Context Bridge adds explicit, expiring local chat-to-chat transfer. This document orchestrates the approved subsystem plans and does not replace their file-level TDD steps.

**Tech Stack:** TypeScript 5.9.2, Bun, Zod 4.6.1, Biome 2.2.0, OKF v0.2, YAML 2.8.3, CodeGraph 1.6.0, native Git, OpenSSH SSHSIG, `jose` 6.2.12, PostgreSQL with pgvector, Ruby 3 with Rake and Sequel migrations, `pg`, CPU ONNX embeddings through `@xenova/transformers` using `all-MiniLM-L6-v2`, `@modelcontextprotocol/sdk` 1.30.0, and gitleaks 8.30.1.

**Spec:** `docs/superpowers/specs/2026-09-11-phase-2-memory-roadmap.md`; public wire contracts are authoritative in `docs/api-reference.md`.

## Global Constraints

- Treat `docs/api-reference.md` as authoritative for Phase 2 HTTP, MCP, persisted-record, error, idempotency, and versioning contracts.
- Prefer approved 2026-09-11 and 2026-09-12 designs and plans over older schematic examples. Historical Chroma examples are superseded.
- PostgreSQL is the canonical shared-memory store. The isolated Ruby/Sequel migration service owns schema changes; the Bun worker creates CPU embeddings in-process and reads and writes the single `wagglebot_memories` table.
- Preserve the Sequel plan's operational controls: advisory-locked migrations, complete ordered migration checks, explicit rollback, a committed schema-only reference, and scoped backup/restore. Do not add a MemPalace adapter, indexing outbox, normalized memory tables, or a TypeScript migration runner.
- Keep code, Git history, CodeGraph data, the `.agents/memory/` OKF bundle, Context Bridge packets, tool credentials, authentication session tokens, and MCP trust approvals on the workstation.
- Keep component memory only in committed OKF concept files under `.agents/memory/`. Shared storage accepts only system, domain, and organization scopes.
- Never persist, upload, infer from, or mine chat transcripts. Retrieval never becomes durable memory without an explicit proposal and save or remember operation.
- Every shared-memory write and local durable-memory save must pass the two-layer secret scan before persistence.
- Scopes control relevance, routing, and write authorization; they are not a new read-access model between trusted coworkers.
- Derive identity and group membership from the verified authentication principal and catalog. Request fields must never let callers select another identity or team.
- Use strict version-1 schemas, stable error codes, bounded inputs and outputs, explicit idempotency rules, safe logging, and the single-representation MCP content rule.
- Pin every runtime dependency exactly. Do not add a dependency when the standard library or an existing project dependency already provides the capability.
- Implement each subsystem through its approved detailed plan using test-driven development and reviewable commits. Do not combine milestones in one commit.
- At every milestone gate run focused tests first, then `bun run check`, `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check` unless the detailed plan specifies a stricter command.
- Do not stage or modify `.idea/` or any unrelated user-owned working-tree files.

---

## What Wagglebot Is Building

Wagglebot is a vendor-neutral engineering-agent platform with progressively broader, explicitly governed capabilities:

| Product phase | Outcome | Current state |
|---|---|---|
| Phase 1: Provisioning | One company repository provisions skills, subagents, base instructions, project instructions, and MCP configuration into nine supported harnesses without running a service. | Complete and released through CLI `v0.3.4`. |
| Phase 2: Memory and context | Local repository intelligence, authenticated shared registry/tool access, governed cross-repository memory, bounded context assembly, and explicit local context transfer. | Approved designs and detailed plans exist; implementation has started. |
| Phase 3: Collaboration | Presence, persistent messages, channels, handoffs, and lease/fencing-safe task coordination under SSH authentication. | Design only; excluded from the Phase 2 release. |
| Phase 4: Document ingestion | Reviewed documents enter shared memory through a separate scanned pipeline with optional batch extraction. | Design only; excluded from the Phase 2 release. |

Phase 2 deliberately separates authorities:

| Information | Authority | Derived/search representation |
|---|---|---|
| Repository instructions and component memory | Git files in the repository | Local BM25 and context packets |
| Current code relationships | Current checkout | Ignored CodeGraph SQLite database |
| Historical rationale | Git commits, blame, and diffs | Bounded Git evidence |
| Company and team tool configuration | Company configuration repository | Authenticated principal-specific registry snapshot and local discovery cache |
| System facts explicitly confirmed by a user | PostgreSQL memory records | Worker-created pgvector embedding and scoped PostgreSQL search |
| Reviewed company/team knowledge | Markdown in the company configuration repository | Derived records in the same PostgreSQL memory table |
| Cross-chat working context | Explicit local Context Bridge packet | Expiring protected workstation vault |

## Documentation Authority

When two documents differ, resolve them in this order:

1. `docs/api-reference.md` for public Phase 2 wire contracts.
2. `docs/superpowers/specs/2026-09-26-okf-local-memory-design.md` for local
   component-memory format and behavior.
3. The current 2026-08-28 shared-layer, C3 service-contract, and Phase 4
   ingestion specifications for shared-memory storage and migrations.
4. `docs/superpowers/plans/2026-09-16-sequel-shared-memory-foundation.md` for
   shared-memory implementation sequence.
5. The non-historical subsystem plans and designs for their own areas.
6. Numbered decisions D1-D37 in the original design.

Ludwig's `a99148e` update is the storage architecture decision: a separate
Ruby/Sequel migration container owns one `wagglebot_memories` table, while the
Bun worker creates `all-MiniLM-L6-v2` CPU embeddings in-process. It supersedes
the earlier MemPalace, indexing-outbox, normalized-table, and TypeScript
migration approach. The dashboard still depends on Phase 3 collaboration data
and remains outside the Phase 2 release.

## Current Implementation Baseline

Status updated on 2026-10-25 on `DEV-002` after the local Phase 2 gate passed:

| Area | Evidence | Status |
|---|---|---|
| Phase 1 CLI and provisioning | `packages/cli`, nine-harness support, project instruction sync, CLI release `v0.3.4` | Built and released |
| Shared contract/scanner groundwork | Commit `c37c31f` adds contract and scanner fixtures | Committed groundwork |
| Phase 2 subsystem designs and detailed plans | Current plans plus historical plans marked superseded | Active work follows the current plan for each subsystem |
| Shared Memory Foundation | Authenticated/scanned writes, reads, publication, recovery, CPU embeddings, and native pgvector integration | Complete; Sol approved |
| Local Repository Brain and OKF runtime | BM25, path policy, CodeGraph, Git, CLI, low-level MCP tools, OKF bundle/provider, and shared project/brain lifecycle are implemented | Task 1A implementation, documentation, and release gate complete |
| SSH authentication | `services/auth` and `packages/auth-protocol` verify SSH signatures and issue/verify sessions | Complete; real SSH exchange exercised in Compose |
| Shared database/admin design updates | Ludwig commit `a81a37f` on this branch | Database foundation active; dashboard deferred until after Phase 3 |
| Authenticated registry | `services/registry` serves validated authenticated registry snapshots | Implemented |
| Local MCP hub | Credential/trust isolation, four transports, discovery, CodeMode, introspection, and local HTTP runtime | Complete; exercised with remote registry/memory and native context subprocess |
| Shared memory runtime | HTTP/MCP, reviewed publication, admin recovery, durable replay, wire mapping, and scoped backup/restore | Complete; native/container PostgreSQL and production model/scanner checks pass |
| Unified Context Engine | Catalog identity, bounded retrieval/ranking, freshness, conflicts, cursors, four MCP tools, and evaluation | Complete; Sol approved and composed gate passed |
| Context Bridge | Protected packet vault, process coordination, export/import/status/revoke, TTL and capacity limits | Complete; Sol approved, concurrency stress and offline composed gate passed |

Current continuation follows
`docs/superpowers/plans/2026-10-06-phase-2-completion.md`. The additive migration
and explicit wire mapping support `wake`, `reviewAfter` and enum confidence.
On 2026-10-24, an isolated native PostgreSQL 17/pgvector cluster ran all four
memory/admin integration tests successfully under `TZ=America/Los_Angeles`.
The Ruby suite passed 17 tests/107 assertions with no skips, including rollback
and schema export. The schema reference was regenerated from that cluster.
This evidence does not verify real CPU embeddings, the pinned gitleaks binary,
publication SQL integration, scoped backup/restore, or the composed release gate.

The same continuation passed the full Bun suite (910 passed, six skipped,
zero failed across 916 tests/129 files). Four database skips were separately
executed successfully above; two optional CodeGraph tests remain unexecuted.
Workspace check, typecheck and CLI build passed. Admin key reuse across an
in-flight run and rescan/reindex now conflicts rather than corrupting replay.
Later the same day, C2 review and missing SQL recovery coverage passed, and the
C3 publication/admin CLI slice was implemented and reviewed. The latest full
approved Bun run passed 924 tests with eight skips (six real database tests
executed separately and two optional CodeGraph tests). All 116 memory-worker
tests passed with real pgvector enabled and no skips. The CLI preserves committed
source bytes, company subdirectories and content-free operator responses.
Latest evidence (2026-10-24): C3 scoped backup/restore passed the full Ruby suite
(24 runs, 173 assertions, zero skips) with `SNAPSHOT_SCAN_INTEGRATION=1` and the
official-checksum-verified gitleaks 8.30.1 binary. Real scanning accepted clean
input and rejected three synthetic secrets, including the GitHub PAT rule;
fresh-process CPU-model checks each produced finite nonzero 384-dimensional
vectors. The composed HTTP/PostgreSQL/model/scanner/key/catalog runtime passed
one test with 14 assertions. The approved Bun run passed 939 tests with eight
skips before the optional production-scanner integration test was added; the
default skip total is now nine (six database gates and the production-scanner
gate were executed separately; two optional CodeGraph tests remain skipped).
All 117 memory-worker tests passed against real pgvector with no skips. C3
backup/restore and trusted Git ancestry SQL proof are complete. Task D is
authorized to begin; Sol approval remains required to close the shared-memory
milestone. Phase 2 release, context and Bridge gates remain open.

Hub verification checkpoint (2026-10-06): the full Bun suite passed with 789
tests across 103 files and two optional CodeGraph skips; typecheck and build
passed. A native startup smoke check returned `/livez` and `/readyz` 200,
rejected unauthenticated `/mcp` with 401, and closed the runtime repeatedly.
Transport fixtures cover HTTP, SSE, and `stdio_cmd`; `stdio_npx` uses a fake
local npx launcher to verify the pinned package and arguments without a package
download. The Ruby database suite ran 13 tests and 54 assertions with three
database integration skips. The full Phase 2 release gate remains open.

Latest continuation (2026-10-25): Tasks D (Unified Context Engine) and E
(Context Bridge) are implemented, with evaluation fixtures, MCP integration,
and Bridge end-to-end tests. `bun run check`, `bun run typecheck`,
`bun run build`, and `git diff --check` passed. `bun test` passed 988 tests with 10
optional skips; the three CodeGraph integration tests passed separately. Real
PostgreSQL 17.11/pgvector 0.8.6 worker tests passed (11 tests/78 assertions),
the production memory HTTP/model/scanner/auth/restart smoke passed (14
assertions), and the Ruby/Sequel suite passed (24 runs/173 assertions, zero
failures/errors/skips, with both database URLs and the pinned scanner enabled).
The main branch merge is present in `DEV-002`.
This intermediate checkpoint is superseded by the final gate below.

Final gate (2026-10-25): the Compose images built and all shared services became
healthy with verified HTTPS and database TLS. The three-repository/two-system
scenario passed real SSH auth, registry and native hub/context MCP, scoped
system/domain/org retrieval, private component-memory isolation, changed-code
and changed-fact cursors, process restart/reset, wake budgets, reviewed company
and team publication/replacement/removal, admin jobs, durable replay, outbound
request/log/database privacy, offline local retrieval, and Bridge isolation.
Independent Sol reviews approved shared memory, context/Bridge, catalog wiring,
and the SDK/Git/runtime packaging repairs. The full Bun suite passed 1,020 tests
with ten optional gates run separately, no failures; check/typecheck/build pass.
The final production container smoke passed with 14 assertions. Earlier native
Ruby evidence remains 24 runs/173 assertions with no skips. GitHub CI and
release workflows are unchanged. Phase 2 implementation and local release
gates are complete; publishing packages is separate work.

## Dependency Graph

```text
Phase 1 (complete)
  |
  +--> Local Brain foundations --> OKF component memory ------------------+
  |                                                                      |
  +--> SSH Authentication --> Registry --> Local MCP Hub ----------------+--> Unified Context Engine
          |                                                              |             |
          +--------------------> Shared Memory Foundation ----------------+             +--> Context Bridge
```

The execution order is therefore:

1. Stabilize the already-started Shared Memory Task 1 contract checkpoint.
2. Build the Local Repository Brain.
3. Replace the Repository Brain's unshipped single-file consumer with OKF local
   memory while retaining Phase 1 v0.3.0's shipped project scaffolding and
   agent-ownership workflow.
4. Build SSH authentication.
5. Build the authenticated registry, then the local MCP hub.
6. Resume the Shared Memory Foundation at Task 2.
7. Build the Unified Context Engine.
8. Build Context Bridge.
9. Run the complete Phase 2 release gate.

---

### Task 0: Stabilize the Current Contract Checkpoint

**Files:**

- Review: `packages/contracts/src/base.ts`
- Review: `packages/contracts/src/memory.ts`
- Review: `packages/contracts/src/principal.ts`
- Review: `packages/contracts/src/memory.test.ts`
- Review: `packages/contracts/src/index.ts`
- Review: `services/memory-worker/package.json`
- Review: `package.json`
- Review: `bun.lock`

**Interfaces:**

- Consumes: strict common schemas from `packages/contracts/src/base.ts` and the shared-memory wire definitions in `docs/api-reference.md`.
- Produces: `SharedScopeSchema`, `MemoryRecordSchema`, `MemorySearchInputSchema`, `MemorySearchResultSchema`, `PrincipalSchema`, all Phase 2 shared-memory request/result schemas, inferred TypeScript types, and a registered `@wagglebot/memory-worker` workspace.

- [x] Compare every exported memory/principal schema with `docs/api-reference.md`, including Unicode bounds, strict unknown-field rejection, `operationKey`, wake/review validation, 20-fact and 256-chunk limits, and HTTP-versus-MCP envelope differences.
- [x] Confirm the `PrincipalSchema` is compatible with the authentication plan's verified-principal contract so authentication will not need a competing principal type.
- [x] Run `bun test packages/contracts/src/memory.test.ts` and require all focused tests to pass.
- [x] Run `bun run check`, `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check`.
- [x] Inspect `git status --short` and `git diff`; exclude `.idea/` and unrelated changes.
- [x] Commit only the Task 1 files with `feat(memory): define shared memory contracts`.
- [x] Stop shared-memory execution after this commit and begin Milestone 1. Do not start database or service runtime work here.

**Gate:** The contract package is internally consistent, the complete repository verification passes, and the checkpoint is reviewable independently from every runtime milestone.

---

### Task 1: Deliver Milestone 1 — Local Repository Brain

> **Historical checkpoint:** The completed single-file memory steps below are
> superseded by Task 1A. Retain their tested BM25, path-policy, secret-scan,
> CodeGraph, Git, CLI, and MCP foundations; do not preserve
> `.agents/memory.md` compatibility.

**Detailed plan:** `docs/superpowers/plans/2026-09-11-local-repository-brain.md`

**Design:** `docs/superpowers/specs/2026-09-11-local-repository-brain-design.md`

**Prerequisites:** Phase 1 component/catalog files, Git, and CodeGraph 1.6.0. No authentication or shared service is required.

**Historical interfaces:**

- Consumes: repository path, current checkout, `.agents/memory.md`, native Git, Phase 1 catalog identity, and the existing secret scanner.
- Produces: `@wagglebot/local-brain`, deterministic BM25, project identity/path policy, local memory proposal/save, CodeGraph and Git providers, CLI brain commands, status, and seven low-level local MCP tools.

- [x] Execute Task 1 of the detailed plan: define focused local-brain types and deterministic BM25 behavior.
- [x] Execute Task 2: canonicalize repository identity and reject paths outside or forbidden within the repository.
- [x] Execute Task 3: parse/search `.agents/memory.md`, generate deterministic transcript-free proposals, scan them, and save atomically with optimistic content-hash checks.
- [x] Execute Task 4: adapt CodeGraph 1.6.0, persist its ignored SQLite index, cap project handles, and prove incremental refresh.
- [x] Execute Task 5: implement bounded Git history and `git_why` using native Git with safe argument handling and time/output limits.
- [x] Execute Task 6: compose the memory, graph, and Git providers and expose freshness/degraded status.
- [x] Execute Task 7: add `wagglebot brain init`, `wagglebot brain remember`, and `wagglebot brain status` without staging or committing user files.
- [x] Execute Task 8: expose the seven low-level local MCP operations and run the detailed milestone gate.
- [x] Review every commit and the aggregate milestone diff for accidental Phase 1 behavior changes.

**Historical gate:** A repository answers local memory, code relationship, and
Git-rationale questions with the network disabled; proposals remain ephemeral
until explicitly saved; the CodeGraph index survives restart and updates
incrementally; no source or transcript data leaves the workstation. Task 1A
replaces the memory format before this becomes the release gate.

---

### Task 1A: Replace Component Memory with OKF v0.2

**Design:** `docs/superpowers/specs/2026-09-26-okf-local-memory-design.md`

**Prerequisites:** The completed Milestone 1 foundations and Phase 1 v0.3.0
project lifecycle. No supported Repository Brain consumer or live memory data
requires a migration or compatibility path. The shipped `init`/`update`
scaffolding and agent-editing idea is preserved in the OKF representation.

**Interfaces:**

- Consumes: repository path, `.agents/memory/` concept files, the existing
  secret scanner, YAML 2.8.3, atomic file writes, and in-process BM25.
- Produces: an OKF v0.2 bundle with one file per concept, deterministic
  progressive indexes, aggregate bundle hashing, exact-path search evidence,
  updated CLI/MCP contracts, and consistent lifecycle documentation.

- [x] Replace the single-file parser and types with a permissive OKF concept
  parser and bounded recursive bundle loader; reject `.agents/memory.md`.
- [x] Generate deterministic root/category indexes from `type`, `title`, and
  `description`; never use a model or index generated files as search content.
- [x] Make project `init`, project `update`, the hidden `sync-project` alias,
  and `brain init` share one idempotent OKF bundle lifecycle. Preserve existing
  concepts and `.agents/changelog.md`; reject the removed file before changing
  project instruction targets.
- [x] Rework propose/save for one concept file, stable source IDs and
  footnotes, exact-path replacement, bundle-hash concurrency, secret scanning,
  atomic concept writes, and explicit stale-index warnings.
- [x] Change `brain remember`, `brain status`, templates, help, and
  agent/onboarding instructions to use only `.agents/memory/`; teach
  progressive index-first reading, direct one-concept-per-file edits, explicit
  remember/correct behavior, and Git review.
- [x] Change low-level MCP and unified-context evidence contracts to return
  exact concept paths and `bundleHash`; update API reference and fixtures.
- [x] Update D29, the Phase 1 provisioning contract, active memory/context
  designs and plans, README, and the persisted-state inventory so no active
  document names the removed file as authoritative.
- [x] Run focused red/green tests followed by `bun run check`,
  `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check`.

**Gate:** A new repository initializes a conformant OKF v0.2 bundle; each saved
memory is one concept; indexes support progressive human/agent discovery;
search returns exact concept provenance; no legacy file is read or written;
and the local brain remains offline, secret-scanned, bounded, and independently
degradable.

---

### Task 2: Deliver Milestone 2 — SSH Authentication

**Detailed plan:** `docs/superpowers/plans/2026-09-12-ssh-authentication.md`

**Contract:** `docs/api-reference.md` section “SSH authentication”.

**Prerequisites:** Backstage User entities and registered SSH public keys in the merged catalog. Complete Milestone 1 first to preserve the approved release order.

**Interfaces:**

- Consumes: catalog identities/public keys, `ssh-agent`, OpenSSH SSHSIG, and issuer key configuration.
- Produces: `@wagglebot/auth-protocol`, one-use challenge storage, canonical challenge bytes, local signing/session cache, EdDSA issuing and verification, `services/auth`, and audience-bound principals for registry, memory, and coordination.

- [x] Execute Task 1 of the detailed plan: define strict versioned authentication request, response, token, and principal contracts.
- [x] Execute Task 2: implement canonical newline-delimited challenge bytes and local SSH signing without exporting a private key.
- [x] Execute Task 3: implement the per-audience in-memory token client/cache and exact-audience verifier.
- [x] Execute Task 4: resolve public keys from the catalog and the optional pinned GitHub host with last-known-good refresh behavior.
- [x] Execute Task 5: add a 60-second, three-attempt, one-use challenge store and generic-failure SSHSIG verification.
- [x] Execute Task 6: issue 900-second EdDSA JWTs and verify issuer, audience, algorithm, expiry, and 30-second clock tolerance.
- [x] Execute Task 7: expose auth health, challenge, and session HTTP routes with safe errors and unauthenticated rate limits.
- [x] Execute Task 8: integrate fixture consumers and prove replay rejection, audience isolation, refresh, and catalog failure behavior end to end.
- [x] Verify logs and persisted state contain no nonce, signature, token, key material, request body, catalog contents, or absolute path.

**Gate:** A registered engineer signs one challenge through `ssh-agent`, receives a short-lived token for exactly one allowed audience, and shared-service verifiers derive the same principal; replay, wrong key, wrong user, wrong audience, expiry, and refresh failures are covered.

---

### Task 3: Deliver Milestone 3A — Authenticated Registry Serving

**Detailed plan:** `docs/superpowers/plans/2026-09-12-authenticated-registry-serving.md`

**Prerequisites:** Milestone 2 authentication verifier and the Phase 1 company repository layout.

**Interfaces:**

- Consumes: authentication `wagglebot-registry` principal, `company/registry.yaml`, matching `teams/<group>/registry.yaml`, all catalog fragments, and the root `tool_catalog.yaml`.
- Produces: a validated, principal-specific registry snapshot with deterministic shallow replacement, revision/ETag behavior, atomic last-known-good refresh, and no credential values.

- [x] Execute Task 1 of the detailed plan: make the registry, tool-catalog, and company-layout schemas canonical and reject removed aliases.
- [x] Execute Task 2: load and validate complete catalog/registry candidates before publication.
- [x] Execute Task 3: derive groups from the authenticated principal and compose company then lexicographically ordered team layers.
- [x] Execute Task 4: expose authenticated `GET /registry`, health endpoints, 256 KiB response bounds, ETag, and safe failure envelopes.
- [x] Execute Task 5: prove principal isolation, atomic refresh, last-known-good behavior, and absence of credentials or trust metadata.

**Gate:** Two fixture principals receive only their deterministic effective registries; callers cannot choose identity or group; an invalid refresh never partially replaces the accepted snapshot.

---

### Task 4: Deliver Milestone 3B — Local MCP Hub

**Detailed plan:** `docs/superpowers/plans/2026-09-12-local-mcp-hub.md`

**Prerequisites:** Milestones 1, 2, and 3A.

**Interfaces:**

- Consumes: local hub bearer token, authentication registry client, principal-specific registry, local credential sources, and explicit trust approvals.
- Produces: `services/mcp-hub`, four upstream transports, atomic registry refresh, bounded discovery cache, CodeMode `search/get_schema/execute`, four introspection tools, and degraded namespace status.

- [x] Execute Task 1 of the detailed plan: define strict hub-facing contracts and configuration.
- [x] Execute Task 2: resolve credentials only on the workstation and require a `0600` trust approval for new or changed privileged registry entries.
- [x] Execute Task 3: fetch, validate, and atomically swap complete registry revisions; drain removed namespaces and invalidate their schemas.
- [x] Execute Task 4: implement exactly `remote_http`, `remote_sse`, `stdio_npx`, and `stdio_cmd`; strip local hub and authentication credentials before every upstream call.
- [x] Execute Task 5: add bounded, concurrent discovery with five-second discovery timeouts and adaptive refresh.
- [x] Execute Task 6: expose only CodeMode and introspection tools; never expose raw downstream tool lists.
- [x] Execute Task 7: wire Streamable HTTP MCP, local auth, startup/degraded behavior, response caps, and end-to-end transport fixtures.
- [x] Prove `execute` is never retried automatically and that hub logs/errors contain no arguments, credentials, endpoint paths, schemas, or upstream response bodies.

**Gate:** One local endpoint safely discovers and executes across all four transport modes, isolates credentials per namespace, requires trust for privileged changes, and remains useful when one remote namespace is unavailable.

---

### Task 5: Deliver Milestone 4 — Shared Memory Foundation

**Detailed plan:** `docs/superpowers/plans/2026-09-16-sequel-shared-memory-foundation.md`

**Design:** current shared-layer, C3 service contract, and Phase 4 ingestion specification.

**Prerequisites:** Task 0 contract checkpoint, Milestone 2 authentication, catalog fixtures, PostgreSQL with `vector`, Ruby 3/Sequel migration image, and the CPU embedding model.

**Interfaces:**

- Consumes: authentication `wagglebot-memory` principal, catalog scopes/owners, scanned explicit writes, and complete reviewed Git publications.
- Produces: canonical PostgreSQL records, in-process CPU embeddings, migration manifest/schema checks, fact search and invalidation, HTTP/MCP routes, compose deployment, and recovery proof.


- [x] Land the isolated migration service and versioned Phase 2 schema
  artifacts from Tasks 1–2; real pgvector verification remains open below.
- [x] Execute Tasks 3–4 of the Sequel plan for CPU embeddings, fact storage,
  and the authenticated service surface.
- [ ] Execute Task 5 only when the Phase 4 ingestion scope is scheduled; it
  extends the same table and adds the isolated ingestion runner.
- [x] Run integration tests against a real PostgreSQL `vector` extension; do
  not substitute an in-memory database for the milestone gate.

**Gate:** Confirmed system facts are visible across repositories in the same system; component memory never enters shared storage; domain/org writes enforce D23 owners; secret fixtures never reach PostgreSQL; migration and embedding metadata checks prevent incompatible startup; and rebuild/recovery preserve canonical truth.

---

### Task 6: Deliver Milestone 5 — Unified Context Engine

**Detailed plan:** `docs/superpowers/plans/2026-09-11-unified-context-engine.md`

**Design:** `docs/superpowers/specs/2026-09-11-unified-context-engine-design.md`

**Prerequisites:** Milestones 1, 3, and 4.

**Interfaces:**

- Consumes: local-brain providers, authentication memory client, shared-memory search, project identity, task/query, context controls, and content-free cursor state.
- Produces: deterministic planning, concurrent bounded retrieval, weighted reciprocal-rank fusion, deduplication/conflict reporting, token/item budgets, four `brain_*` MCP tools, and status without prose.

- [x] Execute Task 1 of the detailed plan: define strict `ContextPacket`, evidence, conflict, degraded-provider, omitted-reason, control, and status contracts.
- [x] Execute Task 2: add the private shared-memory client and reuse authentication per-audience token caching without persisting tokens.
- [x] Execute Task 3: map wake/search/explain requests deterministically to independent providers.
- [x] Execute Task 4: retrieve concurrently with provider-specific and aggregate deadlines; preserve successful evidence when another provider fails.
- [x] Execute Task 5: apply reciprocal-rank fusion, authority-aware tie breaking, identity/content deduplication, cursor repeat suppression, and explicit conflict reporting.
- [x] Execute Task 6: enforce item, shared-item, byte, and estimated-token budgets before rendering stable Markdown or structured output.
- [x] Execute Task 7: build L0-L3 wake behavior and the context facade; keep automatic L0 local-only with zero retrieved items.
- [x] Execute Task 8: expose `brain_wake`, `brain_search`, `brain_explain`, and `brain_status` while enforcing one prose representation per response mode.
- [x] Execute Task 9: install lifecycle instructions, deterministic/evaluation fixtures, protocol tests, degraded-provider tests, and end-to-end proof.

**Gate:** L0 sends at most 150 estimated tokens and makes no shared request; L1 returns at most three wake-eligible shared facts and spends at most 200 tokens on them; L2/search return at most six total and three shared items by default; cursors do not resend unchanged evidence; packets remain useful when graph or shared memory is unavailable; no query or retrieved prose is logged or persisted.

---

### Task 7: Deliver Milestone 6 — Local Context Bridge

**Detailed plan:** `docs/superpowers/plans/2026-09-12-context-bridge.md`

**Design:** `docs/superpowers/specs/2026-09-12-context-bridge-design.md`

**Prerequisites:** Milestone 5 and its project-identity/path-policy utilities.

**Interfaces:**

- Consumes: explicit user-approved packet fields, canonical project root identity, evidence references, same-OS-user filesystem ownership, and the secret scanner.
- Produces: strict Context Bridge contracts, packet normalization, opaque 43-character handles, a protected expiring vault, lifecycle facade, and four local MCP operations.

- [x] Execute Task 1 of the detailed plan: add strict packet, export/import/status/revoke, metadata, and stable error contracts.
- [x] Execute Task 2: normalize bounded packets and bind project scope to a canonical root key; require explicit workstation scope for cross-repository import.
- [x] Execute Task 3: implement atomic `0700`/`0600` vault storage, opaque handles, one-hour default/four-hour maximum TTL, ownership checks, import counts, cleanup, and aggregate limits.
- [x] Execute Task 4: add export/import/status/revoke lifecycle behavior; keep revoke idempotent without revealing packet existence.
- [x] Execute Task 5: expose the four MCP tools and enforce the same single-representation rule as the context engine.
- [x] Execute Task 6: prove project mismatch, owner mismatch, expiry, revocation, import cap, process restart, size limits, secret rejection, and transcript absence end to end.
- [x] Confirm Wake never discovers or imports bridge packets and imports never mutate durable local or shared memory.

**Gate:** A user explicitly exports a bounded packet and imports it in another local chat through an opaque expiring handle; default project binding, same-user ownership, permissions, limits, revocation, and cleanup hold across process restart; no network or authentication call occurs.

---

### Task 8: Pass the Complete Phase 2 Release Gate

**Files:**

- Review: `docs/api-reference.md`
- Review: `docs/superpowers/specs/2026-09-11-phase-2-memory-roadmap.md`
- Review: all Phase 2 implementation diffs and tests
- Modify only if required by verified behavior: `README.md`, `docs/harnesses.md`, package/service READMEs, deployment documentation, and release metadata

**Interfaces:**

- Consumes: all six completed milestones.
- Produces: one releasable Phase 2 increment whose behavior, deployment, documentation, and public contracts agree.

- [x] Run every subsystem's focused tests and its documented completion gate.
- [x] Start the real local integration stack with PostgreSQL/pgvector, the Sequel migration service, auth, registry, memory worker, the workstation-local MCP hub, and local context engine. Keep the hub in the workstation process boundary rather than a shared Compose service profile.
- [x] Prove a local-only repository question works while all shared services are offline.
- [x] Prove one repository can retrieve a confirmed system fact from another repository without exposing either repository's component memory.
- [x] Prove reviewed company/team publication, complete-revision replacement, removal, Git provenance, rescan, reindex, and restore behavior.
- [x] Prove concurrent/repeated Sequel migrations, complete ordered
  migration-history checks, explicit rollback, schema-reference
  reproducibility, and preservation of unrelated database objects and the
  shared `vector` extension.
- [x] Prove authentication identity, exact audience isolation, principal-specific registry composition, local credential isolation, and trust-change approval.
- [x] Prove all four hub transports, namespace degradation, CodeMode, and introspection bounds.
- [x] Prove L0/L1/L2 context budgets, cursor suppression, conflict handling, provider degradation, and single-representation MCP responses.
- [x] Prove Context Bridge export/import/revoke/expiry and same-user/project boundaries without network access.
- [x] Scan test output, service logs, telemetry fixtures, database audit rows, and persisted local state for source, memory prose, queries, credentials, DSNs, tokens, private paths, and transcripts; require absence where prohibited.
- [x] Run `bun run check`, `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check` from a clean dependency install.
- [x] Inspect the final diff and status for unrelated edits, generated files, debug output, stale comments, accidental public-contract changes, or local paths.
- [x] Update the README status only after all release gates pass and the services are actually shippable.

**Gate:** All twelve release gates in the Phase 2 memory roadmap pass against the real composed stack, all relevant checks are green, public docs match behavior, and no required work remains for the Phase 2 scope.

## Phase 3 and Phase 4 Sequencing

Do not fold Phase 3 or Phase 4 into Phase 2 implementation commits.

After the Phase 2 release gate:

1. Convert `docs/superpowers/specs/2026-08-28-phase-3-collaboration.md` into approved subsystem plans for presence, persistent messaging/channels, and lease/fencing-safe task coordination. Reuse SSH authentication with the reserved `wagglebot-coordination` audience and preserve the trusted-coworker model.
2. Complete and release Phase 3 before planning Phase 4 integration points that depend on coordination behavior.
3. After Phase 3 exposes stable collaboration service functions and scoped
   metadata, write a separate implementation plan for
   `docs/superpowers/specs/2026-09-13-admin-dashboard.md`. Reuse Phase 2
   content-free health, migration, storage, and count surfaces; do not expose
   knowledge text, message bodies, task payloads, results, or credentials.
4. Convert `docs/superpowers/specs/2026-08-28-phase-4-document-ingestion.md` into a separate implementation plan for upload, scanning, deterministic parsing/chunking, optional batch extraction, reviewed publication, and reindex/recovery behavior.
5. Keep the dashboard, `ingest_document`, and all coordination MCP surfaces disabled until their own designs, contracts, threat checks, and completion gates are approved and implemented.

## Execution Discipline

- Use one branch/worktree per milestone when starting from a clean base. The current Task 0 checkpoint is already in the active worktree and should be completed there before isolation decisions are revisited.
- Use the detailed plan's task boundaries as review and commit boundaries; each commit must leave focused tests green.
- At the end of each milestone, stop for code review before beginning the dependent milestone.
- If a detailed plan disagrees with the API reference, update the plan or implementation to the API reference rather than supporting both contracts.
- If verification requires Docker, a real PostgreSQL extension, OpenSSH agent access, filesystem mode semantics, or network fixtures and the environment cannot provide it, report the exact unverified gate instead of weakening or silently skipping it.
- Completion is determined by the final diff and observable gate results, not by the number of implemented files.
