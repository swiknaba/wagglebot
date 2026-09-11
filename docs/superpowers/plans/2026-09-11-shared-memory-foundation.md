# Shared Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the catalog-scoped shared memory worker, canonical PostgreSQL records, MemPalace pgvector indexing, and reviewed Git knowledge publication.

**Architecture:** A TypeScript/Bun memory worker remains the only public memory boundary. It commits canonical records and an index outbox to PostgreSQL, then a narrow adapter files and searches those records through a private MemPalace 3.9.0 service using pgvector. Reviewed knowledge is published from committed Git Markdown; component memory never enters this service.

**Tech Stack:** TypeScript 5.9.2, Bun, PostgreSQL with pgvector, `pg` 8.23.0, `zod` 4.6.1, `yaml` 2.8.3, `jose` 6.2.12, `@modelcontextprotocol/sdk` 1.30.0, `@wagglebot/d26-auth`, MemPalace 3.9.0, gitleaks 8.30.1.

**Spec:** `docs/superpowers/specs/2026-09-11-shared-memory-foundation-design.md`

## Global Constraints

- Keep D9, D20–D24, D26, D28, D29, and D35 unchanged.
- Store no `component` record in PostgreSQL or MemPalace.
- Submit finished facts and reviewed Markdown only. Never mine a checkout or transcript.
- Run the gitleaks and entropy scans before any text reaches PostgreSQL, a job payload, or MemPalace.
- Default every record to `wake: false`. Agent proposals cannot enable wake
  delivery; only an explicit authorized human write or reviewed Git publication
  may set it.
- Require a future `reviewAfter` date no more than 366 days after acceptance
  when `wake: true`.
- Wake retrieval reads PostgreSQL only, returns at most three active,
  high-confidence, unexpired records, and never calls MemPalace.
- Keep Wagglebot-owned runtime code in TypeScript/Bun. Treat MemPalace as a pinned private service dependency.
- Pin `mempalace==3.9.0`; deploy its image by immutable digest. CI must reject a tag-only production image reference.
- Pin every npm dependency exactly. Do not use `^`, `~`, a range, or `latest`.
- Use PostgreSQL parameterized statements. Never compose SQL from user values.
- Log identifiers, outcomes, counts, and timings only. Never log memory text, search queries, Git content, secrets, DSNs, or authorization headers.
- Treat `docs/api-reference.md` as the authoritative wire contract. Cap HTTP
  bodies at 1 MiB, titles at 200 code points, record/chunk content at 4,000 code
  points, proposal batches at 20 facts, and publication batches at 256 chunks.
  Add no application requests-per-minute limit to authenticated memory routes.
- Run `bun run check && bun run typecheck && bun test` at every green-tree checkpoint.

---

## File Map

```text
packages/contracts/
  package.json
  src/index.ts
  src/memory.ts
  src/principal.ts
  src/memory.test.ts

packages/knowledge/
  package.json
  src/index.ts
  src/frontmatter.ts
  src/chunk.ts
  src/keys.ts
  src/*.test.ts

packages/secret-scanner/
  package.json
  src/index.ts
  src/scanner.ts
  src/scanner.test.ts

services/memory-worker/
  package.json
  Dockerfile
  src/config.ts
  src/principal.ts
  src/scopes.ts
  src/db/migrate.ts
  src/db/repository.ts
  src/db/migrations/001_memory.sql
  src/memory/canonicalize.ts
  src/memory/reconcile.ts
  src/memory/write-service.ts
  src/memory/search-service.ts
  src/provider/mempalace-client.ts
  src/provider/format.ts
  src/provider/outbox-worker.ts
  src/publication/service.ts
  src/http/server.ts
  src/mcp/server.ts
  src/index.ts
  src/**/*.test.ts
  integration/*.test.ts

packages/cli/src/commands/
  knowledge-publish.ts
  knowledge-publish.test.ts
  memory-admin.ts
  memory-admin.test.ts

deploy/
  docker-compose.memory.yml
  mempalace.Dockerfile
  README.md

test-app/
  wagglebot.yaml
  company/knowledge/engineering/testing.md
  teams/team-payments/knowledge/conventions/api.md
```

`packages/contracts` carries wire types and Zod schemas shared later by the
local context engine. `packages/secret-scanner` provides the same fail-closed,
content-safe scanner to shared writes and local-memory promotion. It exposes no
logging. `services/memory-worker` owns policy, persistence, provider adaptation,
HTTP, and MCP. CLI commands validate local Git sources and call administrator
endpoints; they do not import worker internals.

---

### Task 1: Add memory wire contracts and workspace support

**Files:**
- Modify: `package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/memory.ts`
- Create: `packages/contracts/src/principal.ts`
- Create: `packages/contracts/src/memory.test.ts`
- Create: `services/memory-worker/package.json`

**Interfaces:**
- Produces: `SharedScopeSchema`, `MemoryRecordSchema`, `MemorySearchInputSchema`, `MemorySearchResultSchema`, `PrincipalSchema`, and their inferred TypeScript types.
- Consumes: nothing.

- [ ] **Step 1: Write failing schema tests**

```typescript
import { expect, test } from "bun:test";
import { MemoryRecordSchema, SharedScopeSchema } from "./memory";

test("shared scopes exclude component memory", () => {
  expect(SharedScopeSchema.safeParse({ kind: "system", name: "payments" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "org" }).success).toBe(true);
  expect(SharedScopeSchema.safeParse({ kind: "component", name: "pay-api" }).success).toBe(false);
});

test("a Git record requires immutable provenance", () => {
  const parsed = MemoryRecordSchema.safeParse({
    id: "018f5f5e-69a7-7f86-8f40-f8f31f8cfa61",
    schemaVersion: 1,
    scope: { kind: "domain", name: "payments" },
    kind: "convention",
    title: "API compatibility",
    content: "Keep one prior API version available.",
    canonicalKey: "git:source:heading:0",
    identityKey: "git:source:heading:0",
    contentHash: "a".repeat(64),
    confidence: "high",
    status: "active",
    wake: true,
    reviewAfter: "2027-03-01",
    provenance: [{
      sourceType: "git",
      actor: "memory-publisher",
      repository: "company/wagglebot-config",
      path: "company/knowledge/api.md",
      commitSha: "b".repeat(40),
      heading: "Compatibility",
      sourceKey: "wglsrc_123",
      capturedAt: "2026-09-11T10:00:00.000Z",
    }],
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
  });
  expect(parsed.success).toBe(true);
});

test("wake eligibility requires a bounded review date", () => {
  expect(MemoryRecordSchema.safeParse(record({ wake: true })).success).toBe(false);
  expect(MemoryRecordSchema.safeParse(record({ wake: true, reviewAfter: "2027-03-01" })).success).toBe(true);
});

test("wake search has no query and is capped at three", () => {
  expect(MemorySearchInputSchema.parse({
    schemaVersion: 1,
    purpose: "wake",
    cascade: { system: "payments", domain: "commerce", includeOrg: true },
    limit: 3,
  })).toBeDefined();
});
```

- [ ] **Step 2: Run the tests and confirm the module is absent**

Run: `bun test packages/contracts/src/memory.test.ts`

Expected: FAIL with `Cannot find module './memory'`.

- [ ] **Step 3: Add exact workspace packages and schemas**

Change the root workspace list to:

```json
"workspaces": ["packages/*", "services/*"]
```

Create `packages/contracts/package.json`:

```json
{
  "name": "@wagglebot/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": { "zod": "4.6.1" }
}
```

Create `services/memory-worker/package.json`:

```json
{
  "name": "@wagglebot/memory-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun src/index.ts", "test": "bun test" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@wagglebot/contracts": "workspace:*",
    "jose": "6.2.12",
    "pg": "8.23.0",
    "yaml": "2.8.3",
    "zod": "4.6.1"
  },
  "devDependencies": { "@types/pg": "8.23.1" }
}
```

Implement the schemas with discriminated unions and ISO timestamp, SHA-256, and full Git SHA validation:

```typescript
import { z } from "zod";

export const SharedScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system"), name: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/) }).strict(),
  z.object({ kind: z.literal("domain"), name: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/) }).strict(),
  z.object({ kind: z.literal("org") }).strict(),
]);

export const MemoryKindSchema = z.enum(["fact", "decision", "warning", "convention", "interface", "runbook"]);
export const MemoryStatusSchema = z.enum(["pending_index", "active", "superseded", "invalidated", "index_failed"]);
export type SharedScope = z.infer<typeof SharedScopeSchema>;
```

Define `MemorySearchInputSchema` as a strict discriminated union. `purpose:
"query"` requires query length 1–2,000, limit 1–20, `includeOrg: true`, and
optional explicit scopes. `purpose: "wake"` accepts no query or explicit scopes,
requires the catalog cascade, and limits results to 1–3. Add `wake: boolean`
defaulting to false and conditional `reviewAfter` validation to record and write
schemas. Define every request/result shape and stable error code exactly as
`docs/api-reference.md`, including mutation `operationKey` behavior and the
closed 20-fact/256-chunk batch limits. HTTP schemas require
`schemaVersion: 1`; MCP tool schemas are negotiated as v1 and omit only that
repeated HTTP field. Export every schema and inferred type from `src/index.ts`.

- [ ] **Step 4: Install, test, and check type exports**

Run: `bun install && bun test packages/contracts && bun run typecheck`

Expected: PASS. `bun.lock` contains exact versions.

- [ ] **Step 5: Commit the contracts**

```bash
git add package.json bun.lock packages/contracts services/memory-worker/package.json
git commit -m "feat(memory): define shared memory contracts"
```

---

### Task 2: Validate runtime config, principals, and catalog scopes

**Files:**
- Create: `services/memory-worker/src/config.ts`
- Create: `services/memory-worker/src/config.test.ts`
- Create: `services/memory-worker/src/principal.ts`
- Create: `services/memory-worker/src/principal.test.ts`
- Create: `services/memory-worker/src/scopes.ts`
- Create: `services/memory-worker/src/scopes.test.ts`
- Modify: `packages/contracts/src/principal.ts`

**Interfaces:**
- Consumes: `Principal` and `SharedScope` from `@wagglebot/contracts`; the Phase 1 `Catalog` shape.
- Produces: `loadMemoryConfig(env): MemoryConfig`, `verifyPrincipal(header, config): Promise<Principal>`, `authorizeWrite(principal, scope, catalog, operation): void`, and `validateReadScopes(scopes, catalog): void`.

- [ ] **Step 1: Write failing authorization tests**

```typescript
test("only the domain owner group may publish a domain record", () => {
  const catalog = fixtureCatalog({ domain: "payments", owner: "team-payments" });
  expect(() => authorizeWrite(principal("alice", ["team-payments"]), { kind: "domain", name: "payments" }, catalog, "remember")).not.toThrow();
  expect(() => authorizeWrite(principal("bob", ["team-search"]), { kind: "domain", name: "payments" }, catalog, "remember")).toThrow(/owner group/);
});

test("system proposals carry fresh confirmation by the same principal", () => {
  const p = principal("alice", ["team-payments"]);
  expect(() => assertSystemConfirmation(p, { confirmedBy: "alice", confirmedAt: p.issuedAt })).not.toThrow();
  expect(() => assertSystemConfirmation(p, { confirmedBy: "bob", confirmedAt: p.issuedAt })).toThrow(/confirmedBy/);
});
```

Add config cases that reject `MEMPALACE_BACKEND=chroma`, a missing public key,
a DSN literal in company YAML, and an embedding dimension other than 384 for the
`minilm` profile.

- [ ] **Step 2: Run tests and verify missing modules fail**

Run: `bun test services/memory-worker/src/config.test.ts services/memory-worker/src/principal.test.ts services/memory-worker/src/scopes.test.ts`

Expected: FAIL with unresolved imports.

- [ ] **Step 3: Implement fail-closed config and token verification**

Use a strict Zod schema:

```typescript
const MemoryConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  mempalaceUrl: z.string().url(),
  mempalaceToken: z.string().min(32),
  sessionPublicKeyFile: z.string().min(1),
  expectedIssuer: z.string().min(1),
  expectedAudience: z.literal("wagglebot-memory"),
  adminToken: z.string().min(32),
  catalogPath: z.string().min(1),
  gitleaksPath: z.string().min(1),
  gitleaksSha256: z.string().regex(/^[a-f0-9]{64}$/),
  embedding: z.object({ provider: z.literal("mempalace"), model: z.literal("minilm"), dimension: z.literal(384) }),
}).strict();
```

Use `verifyD26SessionToken` from `@wagglebot/d26-auth` with the configured
issuer public key and exact `wagglebot-memory` audience. The package owns the
EdDSA algorithm allow-list, issuer, expiration, `sub`, and `jti` validation;
the worker maps the verified `sub` to the current catalog User and converts
catalog membership and the org-owner annotation into `Principal`. Compare the
administrator bearer token with `timingSafeEqual`.

- [ ] **Step 4: Implement scope checks**

```typescript
export function authorizeWrite(p: Principal, scope: SharedScope, catalog: Catalog, operation: WriteOperation): void {
  if (p.kind === "administrator" && operation === "publication") return;
  if (scope.kind === "system") return;
  if (scope.kind === "domain") {
    const domain = catalog.domains.find((d) => d.name === scope.name);
    if (domain === undefined) throw new MemoryError("unknown_scope", 400);
    if (!p.groups.includes(domain.owner)) throw new MemoryError("domain_owner_required", 403);
    return;
  }
  if (!p.orgOwner) throw new MemoryError("org_owner_required", 403);
}
```

Validate every read scope name against the catalog. Keep read relevance separate from write authorization.

- [ ] **Step 5: Run the focused and full checks**

Run: `bun test services/memory-worker/src/config.test.ts services/memory-worker/src/principal.test.ts services/memory-worker/src/scopes.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit config and scope enforcement**

```bash
git add services/memory-worker/src packages/contracts/src/principal.ts
git commit -m "feat(memory): enforce shared memory identity and scopes"
```

---

### Task 3: Add the canonical PostgreSQL schema and repository

**Files:**
- Create: `services/memory-worker/src/db/migrations/001_memory.sql`
- Create: `services/memory-worker/src/db/migrate.ts`
- Create: `services/memory-worker/src/db/repository.ts`
- Create: `services/memory-worker/src/db/repository.test.ts`
- Create: `services/memory-worker/integration/postgres.test.ts`

**Interfaces:**
- Consumes: memory contract types and a `pg.Pool`.
- Produces: `MemoryRepository` methods `insertOrReconcile`, `replaceSource`,
  `invalidate`, `get`, `searchLexical`, `searchWakeEligible`, `claimIndexJobs`,
  `completeIndexJob`, `failIndexJob`, and `recordAudit`.

- [ ] **Step 1: Write migration assertions**

Create an integration test that starts from `MEMORY_TEST_DATABASE_URL`, runs the migration, and proves the database rejects component scope:

```typescript
test("database constraint rejects component scope", async () => {
  await expect(pool.query(
    `insert into memory_records
      (id, schema_version, scope_kind, scope_name, kind, title, content, canonical_key, identity_key, content_hash, confidence, status)
     values (gen_random_uuid(), 1, 'component', 'pay-api', 'fact', 'x', 'x', 'x', 'x', repeat('a', 64), 'high', 'active')`,
  )).rejects.toThrow(/memory_records_scope_kind_check/);
});
```

Add tests for one-active-canonical-key uniqueness, provenance immutability, and `FOR UPDATE SKIP LOCKED` returning each job to one concurrent claimant.

- [ ] **Step 2: Run the integration test against an empty database**

Run: `MEMORY_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/wagglebot_test bun test services/memory-worker/integration/postgres.test.ts`

Expected: FAIL because the migration runner and tables do not exist.

- [ ] **Step 3: Write the first migration**

The SQL must begin with:

```sql
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_embedding_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  dimension integer NOT NULL CHECK (dimension > 0),
  distance text NOT NULL CHECK (distance IN ('cosine')),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, dimension, distance, schema_version)
);

CREATE TABLE memory_records (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  scope_kind text NOT NULL CHECK (scope_kind IN ('system', 'domain', 'org')),
  scope_name text,
  kind text NOT NULL CHECK (kind IN ('fact', 'decision', 'warning', 'convention', 'interface', 'runbook')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
  canonical_key text NOT NULL,
  identity_key text NOT NULL,
  content_hash char(64) NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status text NOT NULL CHECK (status IN ('pending_index', 'active', 'superseded', 'invalidated', 'index_failed')),
  wake boolean NOT NULL DEFAULT false,
  review_after date,
  source_key text,
  provider_id text,
  supersedes uuid REFERENCES memory_records(id),
  superseded_by uuid REFERENCES memory_records(id),
  scanner jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'org' AND scope_name IS NULL) OR (scope_kind <> 'org' AND length(scope_name) > 0)),
  CHECK ((wake = false) OR (confidence = 'high' AND review_after IS NOT NULL))
);

CREATE UNIQUE INDEX memory_one_active_canonical
  ON memory_records(scope_kind, coalesce(scope_name, ''), canonical_key)
  WHERE status IN ('pending_index', 'active', 'index_failed');
CREATE INDEX memory_search_gin ON memory_records USING gin(search_document);
CREATE INDEX memory_wake_lookup
  ON memory_records(scope_kind, scope_name, review_after, kind)
  WHERE status = 'active' AND wake = true AND confidence = 'high';
```

Add `memory_provenance`, `memory_sources`, `memory_index_jobs`, and `memory_audit_events` with foreign keys, operation-key uniqueness, attempt count, `next_attempt_at`, and content-free audit columns. Finish with `COMMIT`.

- [ ] **Step 4: Implement migration and repository transactions**

Use one connection per transaction and release it in `finally`:

```typescript
export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

All repository methods use parameter arrays. `searchLexical` filters active
statuses and scopes inside SQL before ranking with `ts_rank_cd`.
`searchWakeEligible` accepts only a resolved cascade and limit 1–3, filters
`status = 'active'`, `wake = true`, `confidence = 'high'`, and `review_after >=
CURRENT_DATE`, and sorts by the fixed kind/scope/review/ID order from the spec.
It returns an additional eligible count without fetching those record bodies.

- [ ] **Step 5: Run PostgreSQL integration tests**

Run: `MEMORY_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/wagglebot_test bun test services/memory-worker/src/db services/memory-worker/integration/postgres.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence**

```bash
git add services/memory-worker/src/db services/memory-worker/integration/postgres.test.ts
git commit -m "feat(memory): persist canonical records and index jobs"
```

---

### Task 4: Implement credential scanning and canonical reconciliation

**Files:**
- Create: `packages/secret-scanner/package.json`
- Create: `packages/secret-scanner/src/index.ts`
- Create: `packages/secret-scanner/src/scanner.ts`
- Create: `packages/secret-scanner/src/scanner.test.ts`
- Modify: `services/memory-worker/package.json`
- Create: `services/memory-worker/src/memory/canonicalize.ts`
- Create: `services/memory-worker/src/memory/canonicalize.test.ts`
- Create: `services/memory-worker/src/memory/reconcile.ts`
- Create: `services/memory-worker/src/memory/reconcile.test.ts`

**Interfaces:**
- Produces: reusable `SecretScanner.scanText(text): Promise<ScanResult>`,
  `canonicalizeFact(input): CanonicalMemory`, and
  `reconcile(existing, candidate): ReconcileDecision`.
- Consumes: an injected process runner and gitleaks 8.30.1 whose executable SHA-256 matches configuration.

- [ ] **Step 1: Write secret and reconciliation tests**

```typescript
test("redacts a synthetic AWS-shaped fixture without returning its value", async () => {
  const secret = `AKIA${"A".repeat(16)}`;
  const result = await scanner.scanText(`Deploy failed while using ${secret}; rotate the credential.`);
  expect(result.action).toBe("redact");
  expect(result.text).toContain("[REDACTED:gitleaks:aws-access-token]");
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("same identity with a different value supersedes the older record", () => {
  const decision = reconcile(existing("runtime", "node20"), candidate("runtime", "node22"));
  expect(decision.kind).toBe("supersede");
  expect(decision.previousId).toBe("old-id");
});
```

Use synthetic, non-working fixtures only.

- [ ] **Step 2: Run tests and verify they fail**

Run: `bun test packages/secret-scanner services/memory-worker/src/memory/canonicalize.test.ts services/memory-worker/src/memory/reconcile.test.ts`

Expected: FAIL with missing implementations.

- [ ] **Step 3: Implement fail-closed gitleaks execution**

Create `@wagglebot/secret-scanner` as a private workspace package and add it to
the memory worker's exact workspace dependencies. Write text to a mode-`0600`
temporary file, invoke gitleaks with argument arrays and JSON output, parse rule
IDs and byte ranges, then delete both temporary files in `finally`. Verify the
binary checksum when constructing the scanner. The runner must never place text
on the command line. The package returns rule IDs, spans, action, and redacted
text; it has no logger and never returns matched secret values.

```typescript
const args = ["detect", "--no-git", "--source", inputPath, "--report-format", "json", "--report-path", reportPath, "--exit-code", "1"];
const result = await runner(config.gitleaksPath, args, { timeoutMs: 10_000 });
if (result.code !== 0 && result.code !== 1) throw new MemoryError("scanner_unavailable", 503);
```

Add Shannon-entropy checks only for token-like runs of at least 24 characters. Reject when redacted spans cover at least 60% of non-whitespace input; otherwise redact from the end toward the start so offsets stay valid.

- [ ] **Step 4: Implement canonical keys and reconciliation**

```typescript
export const identityKey = (f: FinishedFact): string =>
  [f.kind, slug(f.subject), slug(f.relation)].join(":");
export const canonicalKey = (f: FinishedFact): string =>
  `${identityKey(f)}:${slug(f.value)}`;
export const contentHash = (text: string): string =>
  createHash("sha256").update(normalizeText(text)).digest("hex");
```

Same canonical key merges confidence and provenance. A changed value supersedes the existing identity. A lower-confidence contradictory candidate is rejected with `lower_confidence_conflict` and an audit event.

- [ ] **Step 5: Test and commit**

Run: `bun test packages/secret-scanner services/memory-worker/src/memory && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/secret-scanner services/memory-worker/package.json services/memory-worker/src/memory/canonicalize* services/memory-worker/src/memory/reconcile* bun.lock
git commit -m "feat(memory): scan and reconcile accepted facts"
```

---

### Task 5: Implement and verify the MemPalace adapter

**Files:**
- Create: `services/memory-worker/src/provider/format.ts`
- Create: `services/memory-worker/src/provider/format.test.ts`
- Create: `services/memory-worker/src/provider/mempalace-client.ts`
- Create: `services/memory-worker/src/provider/mempalace-client.test.ts`
- Create: `services/memory-worker/integration/mempalace-contract.test.ts`
- Create: `deploy/mempalace.Dockerfile`
- Create: `deploy/vendor-lock.json`

**Interfaces:**
- Produces: `SharedMemoryProvider` with `status`, `index`, `remove`, and `search`; `formatDrawer(record)` and `parseDrawerHit(hit)`.
- Consumes: MemPalace 3.9.0 HTTP MCP tools `mempalace_status`, `mempalace_add_drawer`, `mempalace_search`, and `mempalace_delete_drawer`.

- [ ] **Step 1: Write formatter and mocked MCP tests**

```typescript
test("drawer content begins with a recoverable Wagglebot id", () => {
  const text = formatDrawer(recordFixture());
  expect(text).toStartWith("Wagglebot-Memory-ID: 018f");
  expect(parseDrawerHit({ text, wing: "wgl-org", room: "interface", similarity: 0.91 }).recordId).toBe(recordFixture().id);
});

test("search fans out by wing and rejects an id-free hit", async () => {
  const mcp = fakeMcp([
    toolResult("mempalace_search", { results: [{ text: "unowned", wing: "wgl-org", room: "fact", similarity: 1 }] }),
  ]);
  const hits = await new MemPalaceClient(mcp).search({ query: "api", scopes: [{ kind: "org" }], limit: 5 });
  expect(hits).toEqual([]);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `bun test services/memory-worker/src/provider`

Expected: FAIL because the formatter and client are absent.

- [ ] **Step 3: Build a pinned MemPalace image**

Use the published package rather than a branch checkout. Resolve the current
multi-architecture digest for `python:3.12-slim` with
`docker buildx imagetools inspect`, record the complete
`python:3.12-slim@sha256:...` value in `deploy/vendor-lock.json`, and pass it
as the required build argument:

```dockerfile
ARG PYTHON_BASE_IMAGE
FROM ${PYTHON_BASE_IMAGE}
RUN pip install --no-cache-dir "mempalace[pgvector]==3.9.0"
RUN useradd --uid 1000 --create-home --home-dir /data mempalace
ENV HOME=/data
USER 1000:1000
ENTRYPOINT ["mempalace-mcp"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "8765", "--backend", "pgvector"]
```

The build must fail when `PYTHON_BASE_IMAGE` is absent or does not contain
`@sha256:`. CI builds and publishes the resulting MemPalace image, records that
image's registry digest in the deployment manifest, and deploys by that digest.
Record MemPalace version, license URL, built image digest, Python base digest,
and verification date. CI checks that the Docker build arguments, lock, and
deployment manifest agree.

- [ ] **Step 4: Implement the MCP adapter**

Create one authenticated Streamable HTTP MCP client. Map scope to wing with a total function and kind to room. `index` calls `mempalace_add_drawer`; `remove` calls `mempalace_delete_drawer`; `search` calls once per requested wing, overfetches four times the requested limit with a cap of 80, parses record IDs, and returns provider/channel ranks.

```typescript
export const wingOf = (scope: SharedScope): string =>
  scope.kind === "org" ? "wgl-org" : `wgl-${scope.kind}--${scope.name}`;
```

Validate every tool result with Zod. Map upstream text to stable error classes and discard the raw error before logging.

- [ ] **Step 5: Run the real compatibility suite**

Start PostgreSQL with `vector`, start the pinned MemPalace image with a private namespace, then run:

`MEMPALACE_TEST_URL=http://127.0.0.1:58765/mcp MEMPALACE_TEST_TOKEN=test-only-token MEMPALACE_TEST_DSN=postgres://postgres:postgres@127.0.0.1:55432/mempalace_test bun test services/memory-worker/integration/mempalace-contract.test.ts`

The suite must prove add, duplicate idempotency, exact-term retrieval, semantic retrieval, wing isolation, returned record-ID parsing, deletion, status version `3.9.0`, and reconnect after process restart. Expected: PASS.

- [ ] **Step 6: Commit the provider adapter**

```bash
git add services/memory-worker/src/provider services/memory-worker/integration/mempalace-contract.test.ts deploy/mempalace.Dockerfile deploy/vendor-lock.json
git commit -m "feat(memory): index shared records with MemPalace pgvector"
```

---

### Task 6: Build write, outbox, and hybrid search services

**Files:**
- Create: `services/memory-worker/src/memory/write-service.ts`
- Create: `services/memory-worker/src/memory/write-service.test.ts`
- Create: `services/memory-worker/src/memory/search-service.ts`
- Create: `services/memory-worker/src/memory/search-service.test.ts`
- Create: `services/memory-worker/src/provider/outbox-worker.ts`
- Create: `services/memory-worker/src/provider/outbox-worker.test.ts`

**Interfaces:**
- Produces: `MemoryWriteService.propose`, `.remember`, `.forget`;
  `MemorySearchService.search`, `.wake`; `OutboxWorker.runOnce`.
- Consumes: scanner, repository, scope authorization, and `SharedMemoryProvider`.

- [ ] **Step 1: Write failing service tests**

```typescript
test("accepted memory is immediately visible while provider indexing is pending", async () => {
  const writes = service({ provider: unavailableProvider() });
  const accepted = await writes.remember(rememberInput(), alice());
  expect(accepted.indexState).toBe("pending");
  const found = await searches.search(searchInput("postgres joins"), alice());
  expect(found.results.map((x) => x.id)).toContain(accepted.record.id);
  expect(found.degraded).toContainEqual(expect.objectContaining({ provider: "mempalace" }));
});

test("stale provider hits are filtered through canonical status", async () => {
  const found = await searchesWithProviderHit(invalidatedRecord()).search(searchInput("old rule"), alice());
  expect(found.results).toEqual([]);
});

test("wake returns only reviewed critical facts without calling MemPalace", async () => {
  const provider = recordingProvider();
  const found = await searchesWith([
    record({ id: "eligible", wake: true, confidence: "high", reviewAfter: tomorrow(), status: "active" }),
    record({ id: "ordinary", wake: false, confidence: "high", reviewAfter: tomorrow(), status: "active" }),
    record({ id: "expired", wake: true, confidence: "high", reviewAfter: yesterday(), status: "active" }),
  ], provider).wake(wakeInput({ limit: 3 }), alice());
  expect(found.results.map((x) => x.id)).toEqual(["eligible"]);
  expect(provider.calls).toEqual([]);
});

test("agent proposals cannot enable automatic wake delivery", async () => {
  await expect(writes.propose(agentProposal({ wake: true }), alice())).rejects.toMatchObject({
    code: "agent_wake_forbidden",
  });
});
```

Add system-confirmation, component rejection, domain/org authorization,
duplicate operation-key, retry schedule, exhausted-job, wake limit, kind/scope
ordering, non-high-confidence, inactive, out-of-cascade, review-date renewal, and
additional-eligible-count cases.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test services/memory-worker/src/memory/write-service.test.ts services/memory-worker/src/memory/search-service.test.ts services/memory-worker/src/provider/outbox-worker.test.ts`

Expected: FAIL with missing services.

- [ ] **Step 3: Implement transactional writes**

```typescript
async remember(input: MemoryRememberInput, principal: Principal): Promise<MemoryRememberResult> {
  authorizeWrite(principal, input.scope, this.catalog.current(), "remember");
  const scanned = await this.scanner.scanText(input.content);
  const candidate = canonicalizeRemember(input, scanned, principal, this.clock.now());
  const record = await this.repo.insertOrReconcile(candidate, input.operationKey);
  return { record, indexState: record.status === "active" ? "active" : "pending" };
}
```

Reject agent proposals whose scope is not system or whose confirmation is
missing/stale. Force agent proposals to `wake: false` and reject an explicit
true value. Permit `wake: true` on `remember` only after normal scope
authorization and conditional `reviewAfter` validation. Record content-free
audit events for every enablement, renewal, and other outcome.

- [ ] **Step 4: Implement the outbox worker**

Claim up to 20 due jobs. For `index`, fetch the current active record before calling the provider, then save its provider ID and mark active. For `delete`, remove a known provider ID and complete even when the provider reports not found. Retry at 1, 5, and 30 seconds. After the third failure, mark the record `index_failed` and keep it searchable through PostgreSQL.

- [ ] **Step 5: Implement two-channel search and RRF**

```typescript
const fused = new Map<string, number>();
for (const [channel, hits] of [["postgres", lexical], ["mempalace", semantic]] as const) {
  hits.forEach((hit, index) => fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (60 + index + 1)));
}
```

Query both channels concurrently, validate provider IDs against active canonical rows/scopes, retain channel ranks, and use exact title/canonical-key and scope-specificity tie-breaks. Return provider degradation without raw errors.

Implement `wake` as a separate PostgreSQL-only path. It accepts no query,
never invokes the provider, calls `searchWakeEligible`, returns at most three
records, and includes `additionalEligibleCount`. Keep full content in the wire
record for the context engine to clip within its independent 200-token budget.

- [ ] **Step 6: Run service and integration tests**

Run: `bun test services/memory-worker/src/memory services/memory-worker/src/provider/outbox-worker.test.ts services/memory-worker/integration/postgres.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the memory services**

```bash
git add services/memory-worker/src/memory services/memory-worker/src/provider/outbox-worker*
git commit -m "feat(memory): write and search shared memory safely"
```

---

### Task 7: Publish reviewed Git knowledge deterministically

**Files:**
- Create: `packages/knowledge/package.json`
- Create: `packages/knowledge/src/index.ts`
- Create: `packages/knowledge/src/frontmatter.ts`
- Create: `packages/knowledge/src/frontmatter.test.ts`
- Create: `packages/knowledge/src/chunk.ts`
- Create: `packages/knowledge/src/chunk.test.ts`
- Create: `packages/knowledge/src/keys.ts`
- Create: `packages/knowledge/src/keys.test.ts`
- Create: `services/memory-worker/src/publication/service.ts`
- Create: `services/memory-worker/src/publication/service.test.ts`
- Create: `services/memory-worker/integration/publication.test.ts`

**Interfaces:**
- Produces: `@wagglebot/knowledge` exports `parseKnowledgeDocument`, `chunkKnowledgeDocument`, `sourceKey`, `chunkKey`, and `recordId`; the worker exports `PublicationService.replaceSource`.
- Consumes: complete source revisions from the administrator client, catalog, scanner, and repository.

- [ ] **Step 1: Write failing format and replacement tests**

```typescript
test("rejects unknown front matter instead of ignoring a typo", () => {
  expect(() => parseKnowledgeDocument(`---\nwagglebot:\n  schemaVersion: 1\n  title: API\n  kind: convention\n  scpoe: domain:payments\n  owner: team-payments\n---\nBody`)).toThrow(/scpoe/);
});

test("a new committed revision removes a deleted section from search", async () => {
  await publisher.replaceSource(revision("a".repeat(40), [chunk("kept"), chunk("removed")]));
  await publisher.replaceSource(revision("b".repeat(40), [chunk("kept")]));
  expect((await repo.activeBySource(SOURCE)).map((x) => x.title)).toEqual(["kept"]);
  expect(await repo.statusOf(chunkId("removed"))).toBe("invalidated");
});

test("wake front matter requires a bounded review date", () => {
  expect(() => parseKnowledgeDocument(validDoc({ wake: true }))).toThrow(/reviewAfter/);
  expect(parseKnowledgeDocument(validDoc({
    wake: true,
    reviewAfter: "2027-03-01",
  })).metadata.wake).toBe(true);
});
```

Add stable chunk-ID, 4,000-code-point split, heading ancestry, no overlap,
empty document, owner mismatch, component rejection, repeat revision,
older-revision, and default-false wake cases. In publication-service tests use
an injected clock for past `reviewAfter` and more-than-366-day review-window
cases.

- [ ] **Step 2: Run tests and confirm missing modules**

Run: `bun test packages/knowledge services/memory-worker/src/publication`

Expected: FAIL.

- [ ] **Step 3: Implement strict front matter and Markdown chunks**

Create `packages/knowledge/package.json` with private version `0.0.0` and exact
dependencies `@wagglebot/contracts: workspace:*`, `yaml: 2.8.3`, and
`zod: 4.6.1`. Parse YAML with `yaml` and a strict Zod object. Implement heading
parsing without evaluating embedded HTML. Stable keys use NUL-separated input:

```typescript
const sha256 = (parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");
export const sourceKey = (repo: string, path: string, scope: string) => `wglsrc_${sha256([repo, path, scope])}`;
export const chunkKey = (source: string, headings: string[], ordinal: number) => sha256([source, headings.join(" / "), String(ordinal)]);
```

Validate the optional `wake`/`reviewAfter` shape in the parser. Validate its
date window in `PublicationService` against the injected acceptance clock, then
copy both values to every chunk from that document. Use a fixed UUIDv5 namespace constant from
`packages/contracts`; do not generate random IDs for Git chunks. Add
`@wagglebot/knowledge: workspace:*` to the memory-worker dependencies.

- [ ] **Step 4: Implement atomic source replacement**

Validate and scan every chunk before opening the replacement transaction. Lock the `memory_sources` row. Reject a revision already superseded unless `restoreReason` is present and the principal is administrator. Stage new records, invalidate absent records, update revision, enqueue add/delete jobs, and write one audit event in one transaction.

- [ ] **Step 5: Run publication integration tests**

Run: `MEMORY_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/wagglebot_test bun test packages/knowledge services/memory-worker/src/publication services/memory-worker/integration/publication.test.ts`

Expected: PASS, including concurrent replacement serialization.

- [ ] **Step 6: Commit publication**

```bash
git add packages/knowledge services/memory-worker/package.json services/memory-worker/src/publication services/memory-worker/integration/publication.test.ts bun.lock
git commit -m "feat(memory): publish reviewed Git knowledge"
```

---

### Task 8: Expose HTTP and MCP without exposing MemPalace

**Files:**
- Create: `services/memory-worker/src/http/server.ts`
- Create: `services/memory-worker/src/http/server.test.ts`
- Create: `services/memory-worker/src/mcp/server.ts`
- Create: `services/memory-worker/src/mcp/server.test.ts`
- Create: `services/memory-worker/src/index.ts`

**Interfaces:**
- Produces: `/v1` endpoints, `/livez`, `/readyz`, and MCP tools `memory_search`, `memory_query`, `propose_memory`, `remember`, `forget`.
- Consumes: the services from Tasks 2–7.

- [ ] **Step 1: Write failing route and MCP tests**

```typescript
test("readyz reports provider degradation without returning config", async () => {
  const response = await request(appWith({ postgres: "ok", mempalace: "down", scanner: "ok" }), "/readyz");
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toEqual({ schemaVersion: 1, status: "degraded", dependencies: { postgres: "ready", mempalace: "unavailable", scanner: "ready" } });
  expect(JSON.stringify(body)).not.toContain("postgres://");
});

test("the MCP surface does not expose MemPalace mutation tools", async () => {
  const names = await listToolNames(createMcpServer(fixtureServices()));
  expect(names.sort()).toEqual(["forget", "memory_query", "memory_search", "propose_memory", "remember"]);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test services/memory-worker/src/http services/memory-worker/src/mcp`

Expected: FAIL.

- [ ] **Step 3: Implement HTTP routes and error mapping**

Use Bun's server and exact route table. Validate JSON before calling a service. Cap bodies at 1 MiB. Map `MemoryError.code` to a stable JSON envelope:

```typescript
type ErrorBody = {
  schemaVersion: 1;
  error: { code: string; message: string; correlationId: string; retryable: boolean };
};
```

Do not include `cause`, stack, provider response, matched secret, or request body. `/livez` is auth-exempt. `/readyz` checks database, catalog age, scanner checksum, provider version, and outbox backlog.
Expose the operator drain only as `POST /v1/admin/run-once`; do not add the
historical unversioned `/run-once` alias.

- [ ] **Step 4: Register MCP tools through the service layer**

Use `@modelcontextprotocol/sdk` 1.30.0 and contract JSON schemas. The MCP
handlers call the same authenticated services as HTTP. Publication/admin routes
are not registered as tools. Search/query tools return record prose in
`structuredContent` and a fixed count/status line in text, so direct MCP use
does not inject each fact twice. Mutation tools return concise text plus
content-free structured IDs/status. Read tools carry no `operationKey`;
mutation tools require it and preserve the HTTP idempotency contract.

- [ ] **Step 5: Wire startup and clean shutdown**

```typescript
const runtime = await createRuntime(loadMemoryConfig(process.env));
await runtime.migrate();
await runtime.verifyDependencies();
runtime.outbox.start();
const server = runtime.http.listen();
const stop = async () => {
  await server.stop();
  await runtime.outbox.stop();
  await runtime.provider.close();
  await runtime.pool.end();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
```

- [ ] **Step 6: Test and commit service surfaces**

Run: `bun test services/memory-worker/src/http services/memory-worker/src/mcp && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add services/memory-worker/src/http services/memory-worker/src/mcp services/memory-worker/src/index.ts
git commit -m "feat(memory): serve governed memory over HTTP and MCP"
```

---

### Task 9: Add publication and memory administration CLI commands

**Files:**
- Create: `packages/cli/src/commands/knowledge-publish.ts`
- Create: `packages/cli/src/commands/knowledge-publish.test.ts`
- Create: `packages/cli/src/commands/memory-admin.ts`
- Create: `packages/cli/src/commands/memory-admin.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Produces: `wagglebot knowledge validate`, `wagglebot knowledge publish`, `wagglebot memory rescan`, and `wagglebot memory reindex`.
- Consumes: `@wagglebot/knowledge` and the administrator HTTP API.

- [ ] **Step 1: Write CLI tests using a real temporary Git repository**

```typescript
test("publish refuses a dirty knowledge source", async () => {
  const repo = await committedKnowledgeRepo();
  writeFileSync(join(repo, "company/knowledge/api.md"), validDoc("uncommitted"));
  const result = await runCli(["knowledge", "publish"], deps({ cwd: repo }));
  expect(result.code).toBe(1);
  expect(result.output).toContain("commit or discard the change");
  expect(result.httpCalls).toHaveLength(0);
});

test("publish sends repository-relative provenance and a full commit", async () => {
  const result = await runCli(["knowledge", "publish"], deps({ cwd: await committedKnowledgeRepo() }));
  expect(result.httpCalls[0]?.body.commitSha).toMatch(/^[a-f0-9]{40}$/);
  expect(result.httpCalls[0]?.body.path).toBe("company/knowledge/api.md");
});
```

Add `.wagglebot/public.md`, deleted source, invalid front matter, admin-token absence, JSON summary, and help tests.

- [ ] **Step 2: Run tests and confirm the commands are unknown**

Run: `bun test packages/cli/src/commands/knowledge-publish.test.ts packages/cli/src/commands/memory-admin.test.ts packages/cli/src/help.test.ts`

Expected: FAIL with unknown command or missing module.

- [ ] **Step 3: Implement local Git validation and publication calls**

Use `git status --porcelain=v1 -- <path>`, `git rev-parse HEAD`, and `git ls-files --error-unmatch -- <path>` through the existing `Exec` interface. Never use a remote URL as identity. Read repository identity from `wagglebot.yaml` or the company package metadata.

Send one complete source revision per `PUT` with a deterministic operation key
derived from the source key and full revision. Load endpoint and admin token
from named environment variables; never accept the token as a CLI argument.
Print added/updated/invalidated/no-op counts without content.

- [ ] **Step 4: Implement rescan and reindex commands**

Both commands require the administrator environment token, generate one
operation key per invocation, print the operation ID and counts, and poll the
returned status endpoint until complete or the 30-second CLI deadline. They
never print record text or scanner matches.

- [ ] **Step 5: Wire help and package dependencies**

Add exact dependencies required by the pure knowledge parser. Update root and subcommand help with source cleanliness, scope, credential environment, and no-transcript behavior. Preserve all existing Phase 1 command behavior.

- [ ] **Step 6: Test and commit CLI commands**

Run: `bun test packages/cli/src/commands/knowledge-publish.test.ts packages/cli/src/commands/memory-admin.test.ts packages/cli/src/help.test.ts packages/cli/src/index.test.ts && bun run check && bun run typecheck`

Expected: PASS.

```bash
git add packages/cli package.json bun.lock
git commit -m "feat(cli): publish and maintain shared knowledge"
```

---

### Task 10: Add company scaffold, deployment, recovery, and end-to-end proof

**Files:**
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/init.test.ts`
- Modify: `packages/cli/e2e/scaffold.test.ts`
- Create: `packages/cli/templates/init/wagglebot.yaml`
- Create: `packages/cli/templates/init/company/knowledge/README.md`
- Create: `deploy/docker-compose.memory.yml`
- Create: `deploy/README.md`
- Create: `services/memory-worker/Dockerfile`
- Create: `services/memory-worker/integration/e2e.test.ts`
- Modify: `scripts/regen-test-app.mjs`
- Create: `test-app/wagglebot.yaml`
- Create: `test-app/company/knowledge/engineering/testing.md`
- Create: `test-app/teams/team-payments/knowledge/conventions/api.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: a reproducible shared-memory stack, generated company knowledge examples, dump/restore/reindex runbook, and CI gate.
- Consumes: all earlier tasks.

- [ ] **Step 1: Write the failing generated-scaffold test**

```typescript
test("init scaffolds non-secret memory configuration and reviewed knowledge directories", async () => {
  const root = await runInit();
  const config = readFileSync(join(root, "wagglebot.yaml"), "utf8");
  expect(config).toContain("provider: mempalace");
  expect(config).toContain("dsnEnv: MEMPALACE_PGVECTOR_DSN");
  expect(config).not.toMatch(/postgres:\/\/|password:|token:/i);
  expect(existsSync(join(root, "company/knowledge/README.md"))).toBe(true);
});
```

Add a generated sample marked `wake: true` with a bounded `reviewAfter` date and
a normal sample that defaults to `wake: false`. Assert the knowledge README
explains that wake facts are limited startup guardrails, require human review,
expire from automatic delivery, and remain explicitly searchable afterward.

- [ ] **Step 2: Update the company scaffold and regenerate `test-app`**

Add the `wagglebot.yaml` shape from the spec, knowledge READMEs with the exact front-matter contract, and environment names in `.env.credentials.example`. Run `bun run regen:test-app` and verify a second run is clean.

- [ ] **Step 3: Add pinned containers and private networking**

Compose must include PostgreSQL with `vector`, MemPalace, and memory-worker. Publish only the worker port. Give MemPalace and PostgreSQL no host ports in the production profile. Pass DSNs/tokens through secrets or environment, add health checks, set `MEMPALACE_MCP_IDLE_HOURS=0`, and mount no repository or transcript path into MemPalace.

Add a CI script that rejects `image: .*:latest`, tag-only MemPalace production references, `MEMPALACE_BACKEND=chroma`, and a missing digest in `deploy/vendor-lock.json`.

- [ ] **Step 4: Write the end-to-end scenario**

The test must:

```text
1. migrate a clean PostgreSQL database;
2. publish one domain document and one team public contract;
3. submit one confirmed system fact;
4. run the index outbox;
5. search as components in two systems;
6. prove the cascade and absence of component memory;
7. replace and delete one Git source;
8. stop MemPalace and prove degraded lexical search;
9. restart and reindex;
10. rescan a synthetic secret fixture and prove invalidation.
11. publish four wake-eligible facts plus ordinary and expired records;
12. prove wake retrieval returns three eligible facts in deterministic order,
    reports the additional count, and records zero MemPalace calls.
```

Capture service logs and assert that fixture content, query text, DSNs, tokens, and absolute paths are absent.

- [ ] **Step 5: Document operations and recovery**

`deploy/README.md` must give exact commands for startup, `/livez`, `/readyz`, PostgreSQL logical dump, restore into an empty database, full MemPalace reindex, admin-token rotation, D26 public-key rotation, and a failed-index investigation. It must explain that Git-published documents can be rebuilt, while confirmed system facts require the PostgreSQL backup.

- [ ] **Step 6: Run the full release gate**

Run:

```bash
bun run regen:test-app
git diff --exit-code test-app
bun run check
bun run typecheck
bun test
docker compose -f deploy/docker-compose.memory.yml config
```

Then run the container-backed end-to-end test with its documented environment. Expected: all checks PASS; `git diff --exit-code test-app` prints nothing.

- [ ] **Step 7: Commit the deployable milestone**

```bash
git add packages/cli deploy services/memory-worker test-app scripts/regen-test-app.mjs .github/workflows/ci.yml README.md
git commit -m "feat(memory): deliver the shared memory foundation"
```

---

## Plan Completion Gate

Before starting the Local Repository Brain plan:

- All ten task commits are green.
- The MemPalace contract suite records version 3.9.0.
- Production compose resolves every executable image to a digest.
- An accepted system fact survives a full service restart.
- Git source replacement and deletion are reflected immediately in search.
- MemPalace outage leaves lexical search and canonical writes operational.
- Security fixtures appear nowhere in PostgreSQL text fields, MemPalace, logs, errors, or snapshots.
- The original Phase 2 hub/auth contracts remain unchanged and the worker accepts their D26 principal tokens.
- Wake retrieval returns at most three active, high-confidence, unexpired,
  reviewed records, and agent proposals cannot enable it.
- Direct memory MCP search responses contain each fact's prose in one response
  representation.
