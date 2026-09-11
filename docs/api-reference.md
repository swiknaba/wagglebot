# Wagglebot API Reference

**Status:** Authoritative Phase 2 contract

**API version:** `1`

**Scope:** D26 authentication, authenticated registry serving, local MCP hub,
shared memory, local repository brain, unified context, and Context Bridge.
Phase 3 coordination and Phase 4 ingestion are listed as reserved surfaces but
are not enabled by the Phase 2 release.

## Authority and compatibility

This document resolves the older 2026-08-28 schematic endpoint names and
records the complete Phase 2 public contract. The versioned contracts in the
2026-09-11 shared-memory and unified-context specifications, and the 2026-09-12
D26, registry, hub, and Context Bridge documents, are the authoritative
replacements. Implementations must not silently support both unversioned and
versioned mutation paths.

The Phase 1 company repository layout is also authoritative for Phase 2:
`company/registry.yaml` is the company layer and
`teams/<group>/registry.yaml` is a group layer. The removed
`registry.base.yaml` and `registry.team.<group>.yaml` files are rejected, not
treated as aliases. For shared memory, MemPalace 3.9.0 with
PostgreSQL/pgvector replaces every historical Chroma example.

## Common conventions

- JSON requests and responses use UTF-8 and `Content-Type: application/json`.
- Every response has `schemaVersion: 1` when it is a JSON object owned by
  Wagglebot.
- Clients may send `X-Correlation-ID` matching `[A-Za-z0-9._:-]{1,64}`. The
  service generates one when absent and returns it in the error envelope.
- Error responses use:

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "stable_code",
    "message": "safe human-readable message",
    "correlationId": "corr_...",
    "retryable": false
  }
}
```

- Error messages never contain request bodies, credentials, tokens, stack
  traces, provider responses, matched secret text, absolute paths, or source
  content.
- `401` means missing/invalid/expired authentication. `403` means a valid
  principal is not authorized for that operation. `409` means an idempotency or
  revision conflict. `413` means a size limit. `422` means the syntactically
  valid content was rejected by a security or semantic rule. `429` means rate
  limiting. `503` means a dependency or readiness failure.
- Domain mutation requests use an explicit `operationKey` of 1–128 characters
  matching `[A-Za-z0-9._:-]+`.
  Repeating the same operation key with the same canonical request returns the
  original result; reusing it with a different request returns `409
  operation_key_conflict`.
- D26 credential exchange is intentionally excluded from `operationKey`:
  challenges are unique and session exchange consumes a challenge once. MCP
  transport envelopes are also excluded; mutation tools carry an
  `operationKey` in their tool arguments when their underlying operation is
  durable. Local proposal/save and Context Bridge operations use their
  proposal/handle plus content hash as the idempotency boundary documented in
  their sections.
- Application-level request-rate limiting applies only to unauthenticated D26
  exchange in Phase 2. Authenticated shared endpoints and local tools have no
  requests-per-minute limit; their documented body, result, timeout, and
  concurrency bounds still apply. Operators may add ingress limits without
  changing response schemas. `429` is reserved for D26 and operator ingress
  limits.
- Services log identifiers, counts, timings, stable outcome codes, and bounded
  status metadata only.
- `/livez` is shallow, always `200`, and auth-exempt. `/readyz` is
  dependency-aware and returns `503` when the service cannot serve.

### Schema notation

All object schemas are strict: unknown fields are rejected. `?` marks an
optional field, `[]` marks an array, timestamps are RFC 3339 with an offset,
`sha256` is 64 lowercase hexadecimal characters, and publication/source
revisions are full 40-character hexadecimal Git SHA-1 values. Evidence fields
that explicitly permit a short or SHA-256-format commit accept 7–64
hexadecimal characters.
Unless a route says otherwise, JSON request bodies are capped at 1 MiB and JSON
responses at 1 MiB.

```typescript
type ErrorEnvelope = {
  schemaVersion: 1;
  error: {
    code: string;
    message: string;
    correlationId: string;
    retryable: boolean;
  };
};

type SharedScope =
  | { kind: "system"; name: string }
  | { kind: "domain"; name: string }
  | { kind: "org" };

type Provenance = {
  sourceType: "agent" | "human" | "git";
  actor: string;
  repository?: string;
  path?: string;
  commitSha?: string;
  heading?: string;
  sourceKey?: string;
  capturedAt: string;
};

type ProjectIdentity = {
  component?: string;
  system?: string;
  domain?: string;
  owner?: string;
  branch?: string;
  head?: string;
  workingTree: "clean" | "dirty";
  catalogState: "resolved" | "missing" | "invalid";
  catalogWarning?: string;
};

type EvidenceRef =
  | { kind: "local_memory"; path: ".agents/memory.md"; startLine: number; endLine: number; contentHash: string }
  | { kind: "code"; path: string; startLine: number; endLine: number; symbol?: string; graphState: "ready" | "pending" | "stale" }
  | { kind: "git"; commit: string; path?: string; startLine?: number; endLine?: number }
  | { kind: "shared_memory"; memoryId: string; repository?: string; path?: string; commitSha?: string; heading?: string };
```

### Health endpoints

Every HTTP service exposes the same auth-exempt endpoints. Neither accepts a
body, application rate limit, or idempotency key.

- `GET /livez` always returns `200 { "schemaVersion": 1, "status": "live" }`
  while the process can handle HTTP.
- `GET /readyz` returns `200` with `{ "schemaVersion": 1, "status": "ready",
  "dependencies": { ... } }` when it can serve its contract, or `503` with the
  same shape and `status: "degraded"`. Dependency values are stable states such
  as `ready`, `unavailable`, `stale`, or `not_configured`; they never contain
  paths, URLs, credentials, catalog values, or raw errors.

## D26 authentication

The engineer signs a one-time challenge with the existing SSH key through
`ssh-agent`. The private key never leaves the workstation. The catalog's
`wagglebot.dev/ssh-key` annotation is the default public-key source; the
optional GitHub source fetches `<pinned-host>/<username>.keys`. There is no
`users.yaml` and no distributed user token.

### `POST /v1/auth/challenge`

Unauthenticated credential-exchange endpoint. Rate limit: 10 requests per
username and audience per 60 seconds. Request body limit: 32 KiB. Request body:

```json
{
  "schemaVersion": 1,
  "username": "alice",
  "audience": "wagglebot-memory"
}
```

Allowed audiences are `wagglebot-registry`, `wagglebot-memory`, and
`wagglebot-coordination`. Response:

```json
{
  "schemaVersion": 1,
  "challengeId": "ch_...",
  "nonce": "base64url-32-byte-value",
  "username": "alice",
  "audience": "wagglebot-memory",
  "signatureNamespace": "wagglebot-auth@wagglebot.dev",
  "expiresAt": "2026-09-12T12:01:00.000Z"
}
```

The challenge expires after 60 seconds and permits three signature attempts.
The service stores only a hash of the nonce and deletes a successful challenge.
This endpoint is non-idempotent: every accepted request creates a new challenge.

Errors: `400 auth_invalid`, `429 auth_rate_limited`, and `503
auth_unavailable`.

### `POST /v1/auth/session`

Unauthenticated credential-exchange endpoint. The client signs the canonical
newline-delimited challenge envelope with the fixed SSHSIG namespace. Request
body limit: 32 KiB. A challenge allows at most three calls, so there is no
additional requests-per-minute limit. Request:

```text
wagglebot-auth-v1
<challengeId>
<nonce>
<username>
<audience>
<expiresAt>
```

The trailing newline is required. The OpenSSH SSHSIG namespace is exactly
`wagglebot-auth@wagglebot.dev` and is not configurable by the caller.

```json
{
  "schemaVersion": 1,
  "challengeId": "ch_...",
  "username": "alice",
  "signature": "openssh-sshsig-text"
}
```

Response:

```json
{
  "schemaVersion": 1,
  "accessToken": "eyJ...",
  "tokenType": "Bearer",
  "expiresAt": "2026-09-12T12:15:00.000Z",
  "principal": {
    "username": "alice",
    "keyFingerprint": "SHA256:..."
  }
}
```

The JWT lifetime is 900 seconds. Claims are `iss`, `sub`, `aud`, `iat`, `exp`,
and `jti`. Verifiers allow only `EdDSA`, require the configured issuer and exact
audience, and use 30 seconds of clock tolerance. A signature, username,
challenge, namespace, or audience mismatch returns generic `401 auth_invalid`.
The endpoint is one-use, not idempotent: replay after a successful exchange or
after the attempt cap returns the same generic error. Other errors are `400
auth_invalid` and `503 auth_unavailable`; the three-attempt challenge cap is
the session endpoint's abuse bound.

The auth service loads the merged catalog before readiness and refreshes it on
the configured interval. An invalid refresh keeps the last accepted public-key
set and marks readiness degraded; an initial failure prevents readiness.
Catalog changes affect new challenges after the next accepted refresh. The
optional pinned-host GitHub key response is cached for 15 minutes. Existing
session tokens remain valid only until their 900-second expiry. The issuer
private key is a deployment secret, and engineer private keys never enter the
service or any Wagglebot persisted record.

## Authenticated registry

### `GET /registry`

Requires a D26 Bearer token with audience `wagglebot-registry`. The service
derives the user and group membership from the verified principal and catalog;
query fields cannot select a different user or team. The response composes
`company/registry.yaml` followed by the caller's matching
`teams/<group>/registry.yaml` files in lexicographic group order using
complete-entry shallow replacement. It loads all catalog fragments from
`company/catalog.yaml` and `teams/*/catalog.yaml` into one catalog.

Response:

```json
{
  "schemaVersion": 1,
  "revision": "reg_<sha256>",
  "sourceRevision": "<full-git-sha>",
  "generatedAt": "2026-09-12T12:00:00.000Z",
  "principal": { "username": "alice" },
  "proxies": [],
  "toolCatalog": {}
}
```

The response contains proxy definitions and first-party routing guidance only.
It never contains resolved credentials, D26 tokens, trust approvals, catalog
paths, or upstream responses. `ETag` equals `revision`; `If-None-Match` may
return `304` only after authentication. Response limit: 256 KiB. Source refresh
is atomic; a failed refresh keeps the last accepted revision.

There is no request body, application rate limit, or idempotency key. The GET is
safe and repeatable for one authenticated principal and accepted source
revision. Errors are `401 auth_required`, `401 auth_invalid`, `413
registry_response_too_large`, and `503 registry_unavailable`. The error body
never reveals whether a user, Group, or registry entry exists.

## Local MCP hub

The hub runs on the engineer workstation. It requires its local
`MCP_HUB_BEARER_TOKEN` on `/mcp`; it never forwards that token or the D26
registry token to an upstream. It supports exactly four upstream modes:
`remote_http`, `remote_sse`, `stdio_npx`, and `stdio_cmd`.

### `POST /mcp`

The hub uses MCP Streamable HTTP. The MCP protocol version and request ID live
in the JSON-RPC envelope; tool inputs below are the `tools/call` arguments.
Tool schemas are API version 1 even though the MCP-negotiated schema means the
input does not repeat `schemaVersion`.

```typescript
type SearchInput = {
  query: string;       // 1..500 Unicode code points
  namespace?: string;
  limit?: number;      // 1..20, default 10
};
type SearchResult = {
  schemaVersion: 1;
  results: Array<{
    tool: string;
    namespace: string;
    description: string;
    score: number;
  }>;
};

type GetSchemaInput = { tool: string };
type GetSchemaResult = {
  schemaVersion: 1;
  tool: string;
  namespace: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ExecuteInput = {
  tool: string;
  arguments: Record<string, unknown>;
};
type ExecuteResult = {
  schemaVersion: 1;
  tool: string;
  namespace: string;
  result: unknown; // validated MCP CallToolResult, capped before return
};

type NamespaceStatus = {
  namespace: string;
  status: "ready" | "empty" | "error";
  toolCount: number;
  lastSuccessAt: string | null;
  nextRetryAt: string | null;
  reason?: "credential_missing" | "unreachable" | "trust_required" | "invalid_schema";
};
type ListAvailableMcpsResult = {
  schemaVersion: 1;
  namespaces: NamespaceStatus[];
};

type GetToolCatalogResult = {
  schemaVersion: 1;
  revision: string;
  markdown: string;
};
type RecommendToolFamiliesInput = { task: string }; // 1..500 code points
type RecommendToolFamiliesResult = {
  schemaVersion: 1;
  families: Array<{ id: string; title: string; score: number; namespaces: string[] }>;
};
type GetUsageGuideResult = {
  schemaVersion: 1;
  markdown: string;
};
```

The exposed tools and their exact argument/result pairs are:

| Tool | Input | Result |
|---|---|---|
| `search` | `SearchInput` | `SearchResult` |
| `get_schema` | `GetSchemaInput` | `GetSchemaResult` |
| `execute` | `ExecuteInput` | `ExecuteResult` |
| `list_available_mcps` | `{}` | `ListAvailableMcpsResult` |
| `get_tool_catalog` | `{}` | `GetToolCatalogResult` |
| `recommend_tool_families` | `RecommendToolFamiliesInput` | `RecommendToolFamiliesResult` |
| `get_usage_guide` | `{}` | `GetUsageGuideResult` |

The client never sees raw downstream tools. Qualified names are
`<namespace>_<local_name>`, descriptions are capped at 280 characters after
control/instruction-like markup stripping, and provenance always includes the
namespace. Tool schemas are capped at 64 KiB. `search` returns at most 20
results; tool-catalog/usage text is capped at 32 KiB/16 KiB respectively. MCP
request and response bodies are capped at 1 MiB. Upstream HTTP connect timeout
is 30 seconds and streaming read timeout is 300 seconds. Discovery runs at most
four calls concurrently and a discovery call times out after five seconds.

Registry trust approvals are local and stored in `registry.trust.json`. New or
changed commands, packages, credential names, endpoint origins, stdio entries,
and private targets are skipped until `wagglebot mcp-hub approve <namespace>`.
Missing credentials skip one namespace. Missing stdio binaries fail startup;
unreachable remote namespaces remain degraded unless startup strictness is on.

There is no application requests-per-minute limit. `search`, `get_schema`, and
the introspection tools are read-only. `execute` is never automatically retried
by the hub and inherits the selected upstream tool's mutation and idempotency
semantics; the hub cannot manufacture an idempotency key for an arbitrary
upstream. Errors are returned as MCP tool errors with one of
`hub_invalid_request`, `hub_auth_required`, `hub_auth_invalid`,
`hub_tool_unavailable`, `hub_namespace_unavailable`, `hub_upstream_timeout`,
`hub_upstream_invalid_response`, `hub_response_too_large`, or `hub_internal`.
Error data never contains arguments, credentials, endpoint paths, schemas, or
upstream response content.

## Shared memory worker

Agent and engineer endpoints require a D26 token with audience
`wagglebot-memory`, except health endpoints. Administrator endpoints require
the configured administrator bearer token; there is no undocumented
catalog-authorized bypass. The worker derives the principal from `sub`,
reloads catalog membership, and performs all secret scanning and authorization
server-side.

```typescript
type MemoryKind = "fact" | "decision" | "warning" | "convention" | "interface" | "runbook";
type MemoryStatus = "pending_index" | "active" | "superseded" | "invalidated" | "index_failed";
type Confidence = "low" | "medium" | "high";

type MemoryRecord = {
  id: string; // UUID
  schemaVersion: 1;
  scope: SharedScope;
  kind: MemoryKind;
  title: string;   // 1..200 code points
  content: string; // 1..4,000 code points
  canonicalKey: string;
  identityKey: string;
  contentHash: string;
  confidence: Confidence;
  status: MemoryStatus;
  wake: boolean;
  reviewAfter?: string; // YYYY-MM-DD; required when wake=true
  provenance: Provenance[];
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
};

type WriteResult = {
  schemaVersion: 1;
  operationKey: string;
  outcomes: Array<{
    recordId: string;
    outcome: "created" | "merged" | "superseded" | "unchanged" | "rejected";
    indexState: "pending" | "active" | "failed";
    code?: string;
  }>;
};

type MemorySearchResult = {
  schemaVersion: 1;
  records: Array<{
    record: MemoryRecord;
    fusedRank: number;
    channelRanks: { lexical?: number; semantic?: number };
  }>;
  provider: { lexical: "ready"; semantic: "ready" | "unavailable" };
  degraded: boolean;
  additionalEligible?: number;
};

type MemorySearchInput =
  | {
      schemaVersion: 1;
      purpose: "query";
      query: string;
      cascade: { component?: string; system: string; domain?: string; includeOrg: true };
      scopes?: SharedScope[];
      limit?: number; // 1..20, default 10
    }
  | {
      schemaVersion: 1;
      purpose: "wake";
      cascade: { system: string; domain?: string; includeOrg: true };
      limit?: 1 | 2 | 3;
    };

type MemoryProposalRequest = {
  schemaVersion: 1;
  operationKey: string;
  facts: Array<{
    scope: { kind: "system"; name: string };
    kind: MemoryKind;
    title: string;
    content: string;
    confidence: Confidence;
    provenance: Provenance[];
    confirmedBy: string;
    confirmedAt: string;
  }>;
};
```

### `POST /v1/memory/proposals`

Agent-generated finished facts. The body is capped at 1 MiB and `facts` at 20.
Request:

```json
{
  "schemaVersion": 1,
  "operationKey": "op_...",
  "facts": [
    {
      "scope": { "kind": "system", "name": "payments" },
      "kind": "decision",
      "title": "Use PostgreSQL",
      "content": "...",
      "provenance": [],
      "confirmedBy": "alice",
      "confirmedAt": "2026-09-12T12:00:00.000Z"
    }
  ]
}
```

Each fact uses `scope: { kind: "system", name }`, a `MemoryKind`, title,
content, `Confidence`, one or more `Provenance` entries, `confirmedBy`, and
`confirmedAt`. Agent proposals cannot target component, domain, or org storage
and cannot set `wake: true`. A system proposal needs confirmation by the
authenticated principal no older than the session token. Response:
`WriteResult`.

Idempotency uses `operationKey`. Errors are `400 memory_invalid`, `400
unknown_scope`, `400 confirmation_required`, `401 auth_required`, `401
auth_invalid`, `403 agent_scope_forbidden`, `403 agent_wake_forbidden`, `409
operation_key_conflict`, `413 request_too_large`, `422 secret_rejected`, and
`503 memory_unavailable` or `scanner_unavailable`.

### `POST /v1/memories`

Explicit human `remember`. Request and response:

```typescript
type RememberRequest = {
  schemaVersion: 1;
  operationKey: string;
  scope: SharedScope;
  kind: MemoryKind;
  title: string;
  content: string;
  confidence: Confidence;
  wake?: boolean;
  reviewAfter?: string;
  provenance: Provenance[];
};
type RememberResponse = WriteResult;
```

Domain writes require membership in the owner Group; org writes require the
catalog org-owner annotation. Component scope remains the committed local
Markdown file and is rejected by this shared endpoint. `wake: true` requires
high confidence and a review date no more than 366 days away. Idempotency uses
`operationKey`. Errors are the common auth/size/operation errors plus `400
memory_invalid`, `400 unknown_scope`, `403 domain_owner_required`, `403
org_owner_required`, `422 secret_rejected`, `409 lower_confidence_conflict`,
and `503 memory_unavailable` or `scanner_unavailable`.

### `POST /v1/memories/:id/invalidate`

Explicit `forget`. Request:

```json
{ "schemaVersion": 1, "operationKey": "op_...", "reason": "superseded" }
```

Invalidation is idempotent, preserves provenance/audit history, and enqueues
provider deletion. Response:

```typescript
type InvalidateResponse = {
  schemaVersion: 1;
  operationKey: string;
  recordId: string;
  status: "invalidated";
};
```

Repeating the same `operationKey` or invalidating an already invalidated record
returns the original successful result. Errors add `404 memory_not_found` and
`403 memory_forbidden` to the common mutation errors.

### `POST /v1/memory/search`

Query request:

```json
{
  "schemaVersion": 1,
  "purpose": "query",
  "query": "how does token rotation work",
  "cascade": { "component": "payments-api", "system": "payments", "domain": "commerce", "includeOrg": true },
  "scopes": [],
  "limit": 10
}
```

Queries are 1–2,000 Unicode code points and return 1–20 records. Wake request:

```json
{
  "schemaVersion": 1,
  "purpose": "wake",
  "cascade": { "system": "payments", "domain": "commerce", "includeOrg": true },
  "limit": 3
}
```

Wake has no query, calls PostgreSQL only, and returns at most three active,
high-confidence, unexpired `wake: true` records. Search responses include
canonical IDs, record fields, provenance, freshness, provider status, and
degradation metadata using `MemorySearchResult`.

Query `scopes`, when present, contain only `SharedScope` values; the worker
validates every named scope against the catalog. Search is read-only and has no
idempotency key or application rate limit. Errors are `400 memory_invalid`,
`400 unknown_scope`, `401 auth_required`, `401 auth_invalid`, `413
request_too_large`, and `503 memory_unavailable`. MemPalace failure alone is a
successful degraded response using PostgreSQL lexical results.

### `GET /v1/memories/:id`

Returns one active or historical canonical record and immutable provenance when
the authenticated caller may read it. It never returns provider-only drawer
content or raw source files. Response:

```typescript
type GetMemoryResponse = { schemaVersion: 1; record: MemoryRecord };
```

The GET has no request body, idempotency key, or application rate limit. Errors
are `401 auth_required`, `401 auth_invalid`, `403 memory_forbidden`, `404
memory_not_found`, and `503 memory_unavailable`.

### `PUT /v1/publications/:sourceKey`

Administrator-only complete replacement of one reviewed Git source:

```typescript
type PublicationRequest = {
  schemaVersion: 1;
  operationKey: string;
  revision: string;
  repository: string;
  path: string;
  scope: SharedScope;
  owner: string;
  chunks: Array<{
    chunkKey: string;
    heading: string;
    kind: MemoryKind;
    title: string;
    content: string;
    confidence: Confidence;
    wake: boolean;
    reviewAfter?: string;
    provenance: Provenance[];
  }>;
};
type PublicationResponse = {
  schemaVersion: 1;
  operationKey: string;
  sourceKey: string;
  revision: string;
  created: number;
  updated: number;
  invalidated: number;
  unchanged: number;
};
```

The path is repository-relative, each chunk is capped at 4,000 code points,
the chunk list at 256, and the body at 1 MiB. Repeating the same revision and
canonical body is a no-op; an older revision returns `409
source_revision_regressed`; removed chunks are invalidated atomically. Partial
source replacement is not supported. Other errors are `400
publication_invalid`, `401 admin_auth_required`, `401 admin_auth_invalid`,
`409 operation_key_conflict`, `413 request_too_large`, `422 secret_rejected`,
and `503 memory_unavailable` or `scanner_unavailable`.

### Admin endpoints

All require the administrator bearer token, a 1 MiB body cap, and an
`operationKey`. They have no application requests-per-minute limit.

| Endpoint | Request after `schemaVersion`/`operationKey` | Success response | Additional errors |
|---|---|---|---|
| `POST /v1/admin/rescan` | `{}` | `{ operationId, scanned, invalidated, ruleIds }` | `scanner_unavailable` |
| `POST /v1/admin/reindex` | `{ profileId? }` | `{ operationId, queued }` | `embedding_profile_invalid`, `provider_unavailable` |
| `POST /v1/admin/run-once` | `{ limit?: 1..100 }` | `{ operationId, claimed, completed, failed }` | `provider_unavailable` |

All success objects include `schemaVersion: 1` and `operationKey`. They return
counts and identifiers only, never matched content. `/v1/admin/run-once` is an
operator-only compatibility/admin queue drain endpoint and is not an agent MCP
tool.

### Shared-memory MCP tools

| Tool | Input | Result |
|---|---|---|
| `memory_search` | `MemorySearchInput` without repeated HTTP envelope fields | `MemorySearchResult` |
| `memory_query` | `{ id: UUID }` | `GetMemoryResponse` |
| `propose_memory` | `MemoryProposalRequest` without repeated `schemaVersion` | `WriteResult` |
| `remember` | `RememberRequest` without repeated `schemaVersion` | `WriteResult` |
| `forget` | `{ id: UUID, operationKey, reason }` | `InvalidateResponse` |

All five tools call the same authenticated service layer as HTTP. Publication,
rescan, reindex, and restore remain admin HTTP/CLI operations. The tool schemas
are v1 and strict. Read tools have no idempotency key. Mutation tools preserve
the HTTP `operationKey` behavior. Known failures use the same stable codes as
HTTP as MCP tool errors. Search/query put record prose only in
`structuredContent`; mutation results contain identifiers/status only, so text
and structured content never duplicate memory prose.

## Local repository brain MCP

The local brain is stdio/loopback-only and has no D26/network dependency. Its
low-level tool schemas are v1 and strict. Every input requires an absolute
`projectPath`; returned paths are repository-relative.

```typescript
type MemoryEvidence = {
  kind: "file" | "commit" | "adr" | "issue" | "test" | "maintainer_confirmation";
  ref: string;
};
type LocalMemoryProposal = {
  proposalId: string;
  baseContentHash: string;
  section: "Architecture" | "Conventions" | "Commands" | "Decisions" | "Warnings" | "Learnings";
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  action: "add" | "replace" | "no_change" | "needs_resolution";
  patch: string;
  warnings: string[];
};
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
type CodeGraphResult = {
  query: string;
  state: "ready" | "pending" | "stale";
  nodes: Array<{
    id: string;
    kind: string;
    name: string;
    path?: string;
    startLine?: number;
    endLine?: number;
    snippet?: string;
    stale: boolean;
  }>;
  edges: Array<{ from: string; to: string; kind: string }>;
  pendingFiles: string[];
  observedAt: string;
  limitations: string[];
};
type LocalBrainStatus = {
  project: ProjectIdentity;
  memory: { state: "missing" | "ready" | "error"; contentHash?: string; observedAt: string };
  codeGraph: { state: "missing" | "indexing" | "ready" | "pending" | "error"; pendingFiles: string[]; observedAt: string };
  git: { state: "ready" | "error"; head?: string; branch?: string; workingTree?: "clean" | "dirty"; shallow: boolean };
  observedAt: string;
};
```

| Tool | Strict input | Success result |
|---|---|---|
| `local_memory_search` | `{ projectPath, query: 1..2,000 code points, limit?: 1..20 }` | `{ schemaVersion: 1, hits: [{ id, headingPath, content, score, path, startLine, endLine, contentHash }], fileHash }` |
| `brain_memory_propose` | `{ projectPath, section, title: 1..80, summary: 1..1,000, evidence: 1..20 MemoryEvidence[], replace?: { title, contentHash } }` | `{ schemaVersion: 1, proposal: LocalMemoryProposal }` |
| `brain_memory_save` | `{ projectPath, proposal: LocalMemoryProposal }` | `{ schemaVersion: 1, path: ".agents/memory.md", action, previousContentHash, newContentHash, patch }` |
| `codegraph_explore` | `{ projectPath, query: 1..500, maxNodes?: 1..100, includeCode?: boolean }` | `{ schemaVersion: 1, result: CodeGraphResult }` |
| `git_history` | `{ projectPath, path?: repository-relative, limit?: 1..100 }` | `{ schemaVersion: 1, commits: [{ commit, subject, body?, authorDate, authors, changedPaths }], limitations }` |
| `git_why` | `{ projectPath, path: repository-relative, startLine?, endLine?, query?, maxCommits?: 1..200 }` | `{ schemaVersion: 1, result: GitWhyResult }` |
| `local_brain_status` | `{ projectPath }` | `{ schemaVersion: 1, status: LocalBrainStatus }` |

No tool accepts a transcript, prompt, hidden reasoning, session file, or
absolute evidence path. Retrieval never writes durable memory.

`.agents/memory.md` is capped at 256 KiB and each indexed chunk at 4,000 code
points. Total Git output is capped at 1 MiB; at most five commits carry diff
hunks, each hunk is capped at 200 lines and 32 KiB, and a Git subprocess times
out after ten seconds. CodeGraph keeps at most eight project handles.

There is no requests-per-minute limit. Retrieval and status tools are read-only.
`brain_memory_propose` is deterministic and does not write. A save is atomic
but deliberately not replayable: repeating it after the file changed returns
`memory_changed`, preventing a duplicate entry. Errors are MCP tool errors with
`project_not_found`, `path_outside_repository`, `path_forbidden`,
`local_memory_invalid`, `local_memory_too_large`, `memory_changed`,
`proposal_invalid`, `proposal_conflict`, `secret_rejected`,
`codegraph_missing`, `codegraph_unavailable`, `git_unavailable`, `timeout`, or
`local_brain_internal`. Error results never expose absolute roots or raw
subprocess errors.

## Unified context MCP

The local context engine is stdio/loopback-only. The v1 strict inputs are:

```typescript
type ContextControls = {
  maxTokens?: number;
  remainingContextTokens?: number;
  cursor?: string;
  responseFormat?: "markdown" | "structured";
};
type BrainWakeInput = ContextControls & {
  projectPath: string;
  level?: 0 | 1 | 2 | 3;
  task?: string;
};
type BrainSearchInput = ContextControls & {
  projectPath: string;
  query: string;
  sources?: Array<"local_memory" | "code" | "git" | "shared_memory">;
  limit?: number;
};
type BrainExplainInput = ContextControls & {
  projectPath: string;
  query?: string;
  symbol?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
};
type BrainStatusInput = { projectPath: string };
type BrainStatusResult = {
  schemaVersion: 1;
  project: ProjectIdentity;
  providers: Record<"local_memory" | "code" | "git" | "shared_memory", {
    state: "ready" | "degraded" | "missing" | "not_requested";
    observedAt: string;
    code?: string;
  }>;
  freshness: { generatedAt: string; gitHead?: string; branch?: string; workingTree?: "clean" | "dirty" };
  cursorCache: { entries: number; maxEntries: 128; ttlSeconds: 14400 };
  lastRequestTiming?: { totalMs: number; providers: Record<string, number> };
};
```

`brain_wake`, `brain_search`, and `brain_explain` return a v1 `ContextPacket`:

```typescript
type ContextPacket = {
  schemaVersion: 1;
  packetId: string;
  cursor: string;
  mode: "wake" | "search" | "explain";
  request: {
    query?: string;
    task?: string;
    requestedLevel?: 0 | 1 | 2 | 3;
    requestedMaxTokens?: number;
    remainingContextTokens?: number;
    effectiveMaxTokens: number;
  };
  project: ProjectIdentity;
  freshness: {
    generatedAt: string;
    gitHead?: string;
    branch?: string;
    workingTree?: "clean" | "dirty";
    codeGraph: "missing" | "ready" | "pending" | "error";
    pendingFiles: string[];
    sharedRetrievedAt?: string;
  };
  items: Array<{
    id: string;
    source: "local_memory" | "code" | "git" | "shared_memory";
    scope?: "component" | "system" | "domain" | "org";
    kind: string;
    title: string;
    excerpt: string;
    provenance: EvidenceRef[];
    freshness: "live" | "current_revision" | "historical" | "stale" | "unknown";
    channelRanks: Record<string, number>;
    fusedScore: number;
    authorityTier: number;
  }>;
  conflicts: Array<{
    identityKey: string;
    itemIds: string[];
    resolution: "current_source_preferred" | "reviewed_source_preferred" | "unresolved";
    reason: string;
  }>;
  degraded: Array<{
    provider: "local_memory" | "code" | "git" | "shared_memory";
    code: "timeout" | "missing" | "invalid_response" | "unauthorized" | "unavailable" | "internal";
    elapsedMs: number;
  }>;
  omitted: {
    candidates: number;
    estimatedTokens: number;
    reasons: Array<"budget" | "duplicate" | "inactive" | "stale" | "provider_limit" | "item_cap" | "low_relevance" | "not_wake_eligible" | "already_delivered" | "cursor_reset">;
  };
  estimatedTokens: number;
};
```

`brain_status` returns `{ schemaVersion: 1, project, providers, freshness,
cursorCache, lastRequestTiming }` and never returns retrieved prose.

| Tool | Input | Result |
|---|---|---|
| `brain_wake` | `BrainWakeInput` | `ContextPacket` |
| `brain_search` | `BrainSearchInput` | `ContextPacket` |
| `brain_explain` | `BrainExplainInput` | `ContextPacket` |
| `brain_status` | `BrainStatusInput` | `BrainStatusResult` |

L0 is automatic, local-only, at most 150 estimated tokens, and has zero
retrieved items. L1 is explicit, at most 500 tokens and three shared wake facts.
L2/search return at most six items, three shared, and 1,500 estimated tokens.
Every packet is capped at 16 KiB. Cursor state contains only item IDs and
content hashes, never prose or paths.

Queries/tasks are capped at 2,000 code points, cursors at 256 evidence entries,
and the process at 128 cursors with four-hour sliding expiry. Default aggregate
deadlines are 750 ms for L1, 1,500 ms for search/explain, and 2,500 ms for
L2/L3. There is no requests-per-minute limit or durable mutation. An unknown or
expired cursor succeeds with `cursor_reset`. Invalid inputs fail with
`context_invalid`; a missing project with `project_not_found`; and a total
provider failure with `context_unavailable`. Individual provider failures use
`timeout`, `missing`, `invalid_response`, `unauthorized`, `unavailable`, or
`internal` in the successful packet's `degraded` array.

In Markdown mode, prose appears only in MCP text and structured content carries
metadata/handles. In structured mode, prose appears only in structured content
and MCP text is a one-line summary. This single-representation rule is part of
the wire contract.

## Context Bridge MCP

Context Bridge is local-only and explicit; it is not Wake and never uses D26.

```typescript
type ContextBridgePacket = {
  schemaVersion: 1;
  packetId: string; // cb_pkt_ plus 20..80 base64url characters
  project: { rootKey: string; component?: string; system?: string; branch?: string; head?: string };
  scope: "project" | "workstation";
  goal: string;
  decisions: Array<{ title: string; summary: string }>;
  openQuestions: string[];
  evidence: EvidenceRef[];
  providerState: {
    localBrain: "ready" | "degraded" | "missing";
    sharedMemory: "ready" | "degraded" | "not_requested";
  };
  createdAt: string;
  expiresAt: string;
};
```

| Tool | Strict input | Success result |
|---|---|---|
| `brain_context_export` | `{ projectPath, scope?: "project" | "workstation", ttlSeconds?: 1..14,400, goal, decisions, openQuestions, evidence, providerState, responseFormat?: "structured" | "markdown" }` | structured: `{ schemaVersion: 1, handle, packetMeta, packet }`; Markdown: packet metadata plus preview in MCP text |
| `brain_context_import` | `{ handle: 43-character base64url, projectPath, responseFormat?: "structured" | "markdown" }` | structured: `{ schemaVersion: 1, importedContext: ContextBridgePacket, packetMeta }`; Markdown: packet metadata plus imported preview in MCP text |
| `brain_context_status` | `{ projectPath }` | `{ schemaVersion: 1, packetCount, packets: [{ packetId, scope, project, createdAt, expiresAt, importCount }] }` |
| `brain_context_revoke` | `{ handle, projectPath }` | `{ schemaVersion: 1, revoked: true }` |

Default scope is the canonical project root. Workstation scope is explicit at
export and permits same-user cross-repository import. Default TTL is one hour,
maximum four hours, maximum eight imports, 16 KiB packet, 32 live packets, and
512 KiB aggregate vault size. The vault directory is `0700`, files are `0600`,
and imported context never mutates durable memory.

Goal is capped at 300 code points; decision titles at 80 and summaries at 600;
there are at most ten decisions, ten 240-code-point open questions, and twenty
evidence references. Export/import bodies and results are capped at 16 KiB.
There is no requests-per-minute limit or network request. Export is
non-idempotent and creates a fresh handle. Import is read-only but increments
the eight-import counter. Revoke is idempotent for a well-formed handle and
returns the same success after prior revocation without revealing whether a
packet existed.

Errors are MCP tool errors with `context_invalid`, `context_expired`,
`context_project_mismatch`, `context_owner_mismatch`, `context_limit`, or
`context_unavailable`. No error or status response includes a handle, packet
prose, absolute path, or evidence content.

## Persisted records and local state

| Record/state | Owner | Persistence | Contract |
|---|---|---|---|
| D26 challenge store | auth service | process memory | `{ challengeId, nonceHash, username, audience, expiresAtMs, attempts }`; 60-second TTL, deleted on success, no raw nonce |
| D26 session-token cache | workstation D26 client | process memory | one `{ token, expiresAt }` per audience; refreshed within 60 seconds of expiry; never written to disk |
| company configuration repository | company/operator | Git | authoritative catalog fragments, `company/registry.yaml`, `teams/<group>/registry.yaml`, root `tool_catalog.yaml`, and reviewed knowledge; no secrets |
| effective registry snapshot | registry service | process memory | validated principal-specific company/team composition keyed by source revision and username; last-known-good only |
| `memory_records` | memory worker | PostgreSQL | canonical shared fact, status, scope, hashes, wake/review fields |
| `memory_provenance` | memory worker | PostgreSQL | immutable source references |
| `memory_sources` | memory worker | PostgreSQL | complete Git publication revision |
| `memory_index_jobs` | memory worker | PostgreSQL | idempotent add/delete outbox work |
| `memory_embedding_profiles` | memory worker | PostgreSQL | provider/model/dimension/distance/schema |
| `memory_audit_events` | memory worker | PostgreSQL | content-free outcome and actor audit |
| `registry.trust.json` | local hub | workstation file, `0600` | approved privileged registry fingerprints |
| discovery cache | local hub | process memory | downstream schemas; rebuildable, never canonical |
| `.agents/memory.md` | repository/local brain | Git working tree | authoritative component memory; human-readable and reviewed like source |
| `.codegraph/codegraph.db` | CodeGraph/local brain | ignored workstation SQLite | generated current-checkout graph; rebuildable and never uploaded |
| context cursor | context engine | process memory | IDs/hashes only; four-hour sliding expiry |
| Context Bridge vault packets | context engine | workstation files, `0700`/`0600` | bounded expiring explicit packets, never transcripts |

MemPalace is derived and replaceable. It is never a public API or canonical
record store. The hub never persists resolved upstream credentials.

`registry.trust.json` has schema version 1, the pinned registry origin, and a
list of `{ namespace, fingerprint, approvedAt }` records. A fingerprint covers
the complete privileged portion of the entry: transport, command/package,
arguments, endpoint origin/private-target classification, auth scheme, and
credential-source name. It never contains a credential value.

PostgreSQL enforces that `memory_records.scope_kind` is only `system`,
`domain`, or `org`; at most one pending/active/index-failed row exists for one
`(scope, canonical_key)`; provenance rows are immutable; source revisions and
operation keys are unique within their owning source/principal; outbox jobs
record operation, attempts, next attempt, and terminal state; audit rows carry
actor, operation, scope, target ID, outcome, rule IDs, and timestamps but no
memory prose. MemPalace drawer IDs are derived index metadata, never public
record identity.

## Publication and revision semantics

- Registry publication validates the complete catalog/registry/tool-catalog
  candidate from the company repository, then swaps one in-memory source
  snapshot. A principal-specific revision hashes the source revision, username,
  and canonical effective registry. A failed candidate leaves the prior
  revision serving.
- Memory publication replaces a complete source revision atomically. Repeating
  a revision is a no-op; older revisions require administrator restore semantics.
- Hub registry refresh validates, applies local trust approvals, resolves local
  credentials, and swaps the complete candidate. Removed namespaces drain and
  invalidate cached schemas.
- Local memory save compares `baseContentHash`, writes a temporary file, and
  atomically renames it; it never stages or commits the file.
- CodeGraph updates its ignored SQLite representation incrementally from the
  current checkout; Git/source remains authoritative.
- Context Bridge packets use opaque handles, atomic writes, TTL cleanup, and
  idempotent revoke. They are not publication records or durable memory.

## Reserved later-phase surfaces

Phase 3 will add coordination MCP tools (`list_agents`, `send_message`,
`read_channel`, task-board operations) behind D26 `wagglebot-coordination`
tokens. Phase 4 will add `ingest_document` and its separate document pipeline.
Those surfaces are intentionally not enabled by the Phase 2 release, but their
future audience and separation are reserved here so they do not redefine the
Phase 2 contracts.
