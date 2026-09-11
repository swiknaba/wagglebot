# Authenticated Registry Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` when the work is split into independent tasks) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve one validated, principal-specific effective MCP registry to each authenticated local hub without exposing secrets or allowing a caller to choose its own team membership.

**Architecture:** A shared `services/registry` service reads the existing company repository layout, verifies the D26 `wagglebot-registry` audience token, derives the caller's groups from the merged Backstage catalog, and returns `company/registry.yaml` merged with the matching `teams/<group>/registry.yaml` layers. The merge is shallow and deterministic; the complete candidate is validated before an atomic in-memory swap. The service serves no local trust approvals or resolved credentials.

**Tech Stack:** TypeScript, Bun, Zod 4, YAML 2.8.3, `@wagglebot/contracts`, `@wagglebot/d26-auth`, Bun `fetch`, native filesystem APIs, Bun tests, Biome, and the existing `createServer`/`createApp` pattern.

**Spec:** The company/team layout in
`docs/superpowers/specs/2026-08-28-phase-1-provisioning.md`, the registry
behavior in `docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md` and §C2
of `docs/superpowers/specs/2026-08-28-service-contracts.md`, D10, D15, D16,
D20, D26, D27, and D34 in
`docs/superpowers/specs/2026-08-28-wagglebot-design.md`, and the versioned wire
contract in `docs/api-reference.md`.

## Global Constraints

- The registry is a relevance selector, not a team authorization boundary. Every registered engineer receives the company layer plus the team layers selected from the catalog; memory and publication authorization remain separate concerns.
- Require a valid D26 token with exact audience `wagglebot-registry` on `GET /registry`. Derive `username` from verified `sub`; ignore any query/header/body team or username selector.
- Do not create `users.yaml` or a second membership store. The Backstage catalog is authoritative for User, Group, `memberOf`, and ownership data.
- Source files carry credential references only. Reject `credential.source.from: literal` and any unknown auth/source fields in the shared registry. Never return or persist resolved credential values.
- Use the existing strict `ProxyConfig`, `AuthScheme`, `CredentialSource`, and tool-catalog contracts. The CLI and registry service must not maintain competing schemas.
- Validate every layer and the complete effective registry before publication. Reject duplicate namespaces within a layer, malformed endpoints, unpinned `stdio_npx` packages, ranges, `latest`, unknown auth/source fields, and invalid tool-catalog entries.
- Merge shallowly: `company/registry.yaml` entries are loaded first, then the
  caller's `teams/<group>/registry.yaml` files in lexicographic group-name
  order; a later complete team entry replaces the complete company/team entry
  with the same namespace. Never deep-merge fields.
- A registry response contains only validated configuration, revision metadata, and first-party tool-catalog content. It contains no secrets, local file paths, private trust approvals, D26 tokens, or upstream responses.
- The source snapshot is immutable after validation. Publish by replacing the in-memory snapshot as one operation; a failed refresh keeps the last good snapshot and readiness state.
- Use `ETag` equal to the revision identifier. `If-None-Match` may return `304` only after authenticating the caller and confirming the same effective revision; never use an unauthenticated cache hit.
- Return generic authentication errors without revealing whether a username, group, or registry entry exists. Do not log usernames on rejected requests, catalog content, tokens, credentials, endpoints with query/userinfo, or registry prose.
- `/livez` is auth-exempt and shallow. `/readyz` is auth-exempt and returns `503` until the catalog and at least one valid registry snapshot are loaded.
- Registry refresh does not call upstream MCP servers. The local hub performs upstream discovery and applies local trust approvals.
- Run `bun run check && bun run typecheck && bun test` at every green-tree checkpoint.

## Repository Map

```text
packages/contracts/src/registry.ts
packages/contracts/src/registry.test.ts
packages/contracts/src/index.ts
packages/cli/src/registry.ts
packages/cli/src/registry.test.ts
packages/cli/src/company.ts
packages/cli/src/company.test.ts
packages/cli/package.json

packages/company-config/package.json
packages/company-config/src/index.ts
packages/company-config/src/company.ts
packages/company-config/src/company.test.ts

services/registry/package.json
services/registry/Dockerfile
services/registry/src/config.ts
services/registry/src/config.test.ts
services/registry/src/catalog.ts
services/registry/src/catalog.test.ts
services/registry/src/source.ts
services/registry/src/source.test.ts
services/registry/src/compose.ts
services/registry/src/compose.test.ts
services/registry/src/http.ts
services/registry/src/http.test.ts
services/registry/src/index.ts
services/registry/integration/registry-e2e.test.ts

deploy/docker-compose.memory.yml
deploy/README.md
docs/api-reference.md
```

---

## Task 1: Make registry, tool-catalog, and company-layout contracts canonical

**Files:**

- Create: `packages/contracts/src/registry.ts`
- Create: `packages/contracts/src/registry.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/cli/src/registry.ts`
- Modify: `packages/cli/src/registry.test.ts`
- Create: `packages/company-config/package.json`
- Create: `packages/company-config/src/index.ts`
- Create: `packages/company-config/src/company.ts`
- Create: `packages/company-config/src/company.test.ts`
- Modify: `packages/cli/src/company.ts`
- Modify: `packages/cli/src/company.test.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**

- Produces: `ProxyConfigSchema`, `AuthSchemeSchema`,
  `CredentialSourceSchema`, `ToolCatalogSchema`, `RegistrySnapshotSchema`,
  their inferred types, and the shared `loadCompanyRepo`/
  `assertTeamDirsKnown` company-layout loader.
- Consumes: the existing Phase 1 registry validation and company repository
  behavior and D26 `D26Principal` only at service boundaries, not in the pure
  schema package.

- [ ] **Step 1: Write failing contract tests**

```typescript
test("accepts a secret-free pinned remote proxy", () => {
  expect(ProxyConfigSchema.safeParse({
    namespace: "example",
    mode: "remote_http",
    endpoint: "https://mcp.example.com/mcp",
    auth: {
      scheme: { kind: "bearer" },
      source: { from: "env", var: "EXAMPLE_TOKEN" },
    },
  }).success).toBe(true);
});

test.each([
  { mode: "stdio_npx", args: ["-y", "example-mcp@latest"] },
  { mode: "stdio_npx", args: ["-y", "example-mcp@^1.2.0"] },
  { mode: "remote_http", endpoint: "http://mcp.example.com/mcp" },
])("rejects unsafe registry proxy %o", (override) => {
  expect(ProxyConfigSchema.safeParse({ namespace: "example", ...override }).success).toBe(false);
});

test("rejects literal credentials in a shared snapshot", () => {
  expect(CredentialSourceSchema.safeParse({ from: "literal", value: "secret" }).success).toBe(false);
});

test("registry snapshots contain revision and no resolved credential value", () => {
  expect(RegistrySnapshotSchema.safeParse(validSnapshot()).success).toBe(true);
  expect(RegistrySnapshotSchema.safeParse({ ...validSnapshot(), token: "secret" }).success).toBe(false);
});
```

Add table-driven tests for all four transports, all auth schemes, strict
unknown-key rejection, namespace format/uniqueness, absolute HTTPS URLs,
explicit stdio env allow-lists, tool-catalog limits, revision format, ETag
format, and response-size limits.

Run: `bun test packages/contracts/src/registry.test.ts packages/cli/src/registry.test.ts`

- [ ] **Step 2: Implement and export strict schemas**

Move the canonical shapes from the existing CLI loader into
`packages/contracts/src/registry.ts` without changing Phase 1 accepted values.
Add these response types:

```typescript
export const RegistrySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().regex(/^reg_[a-f0-9]{64}$/),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  generatedAt: z.string().datetime({ offset: true }),
  principal: z.object({ username: UsernameSchema }).strict(),
  proxies: z.array(ProxyConfigSchema).max(256),
  toolCatalog: ToolCatalogSchema,
}).strict();
```

The public snapshot must not contain `sourceRoot`, local filenames, trust
approvals, credentials, catalog groups, or the caller's bearer token. Define
`RegistryErrorCodeSchema` with `registry_invalid`, `registry_unavailable`,
`registry_response_too_large`, `auth_required`, and `auth_invalid`.

Move the existing filesystem-only company repository loader from
`packages/cli/src/company.ts` into `@wagglebot/company-config`. Preserve the
current layout exactly:

```text
<company-root>/
├── tool_catalog.yaml
├── company/
│   ├── catalog.yaml
│   └── registry.yaml
└── teams/<group>/
    ├── catalog.yaml
    └── registry.yaml
```

The company and team catalog/registry files remain optional individually, but
at least one catalog must exist, `company/registry.yaml` is the base registry
layer when present, and each team directory name must match a catalog Group.
The loader returns stable, lexicographically sorted layers and never reads the
removed `registry.base.yaml` or `registry.team.<group>.yaml` paths.

Keep `packages/cli/src/company.ts` as a narrow re-export so existing internal
imports and Phase 1 behavior remain compatible. Update the CLI registry loader
to consume the shared schemas and preserve its diagnostics. Add compile-time
tests that the CLI and registry service import the same `ProxyConfig` and
`CompanyRepo` types.

Create `packages/company-config/package.json`:

```json
{
  "name": "@wagglebot/company-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
```

Add `@wagglebot/company-config: "workspace:*"` to the CLI. The package uses
only Node/Bun filesystem and path APIs; do not add a dependency.

Run: `bun test packages/contracts/src/registry.test.ts packages/company-config/src/company.test.ts packages/cli/src/company.test.ts packages/cli/src/registry.test.ts && bun run check && bun run typecheck`

- [ ] **Step 3: Commit the canonical contract**

```bash
git add packages/contracts/src/registry* packages/contracts/src/index.ts packages/company-config packages/cli/package.json packages/cli/src/company* packages/cli/src/registry*
git commit -m "feat(registry): centralize registry and tool-catalog contracts"
```

---

## Task 2: Load and validate catalog-backed registry sources

**Files:**

- Create: `services/registry/src/config.ts`
- Create: `services/registry/src/config.test.ts`
- Create: `services/registry/src/catalog.ts`
- Create: `services/registry/src/catalog.test.ts`
- Create: `services/registry/src/source.ts`
- Create: `services/registry/src/source.test.ts`

**Interfaces:**

- Consumes: Backstage catalog YAML and central registry files.
- Produces: `loadRegistryConfig(env)`, `CatalogSnapshot`, and
  `RegistrySource.load(): Promise<ValidatedSourceSnapshot>`.

- [ ] **Step 1: Test configuration and source loading**

Test that configuration requires:

```typescript
const config = loadRegistryConfig({
  REGISTRY_HOST: "127.0.0.1",
  REGISTRY_PORT: "3040",
  REGISTRY_ISSUER: "https://auth.example.test",
  REGISTRY_COMPANY_ROOT: "/config/company-repository",
  REGISTRY_SOURCE_REVISION: "0123456789abcdef0123456789abcdef01234567",
  REGISTRY_REFRESH_SECONDS: "900",
  REGISTRY_MAX_RESPONSE_BYTES: "262144",
});
expect(config.refreshSeconds).toBe(900);
```

Add tests for missing files, unreadable paths, invalid YAML, duplicate User or
Group entities, unknown `memberOf` groups, duplicate namespaces, invalid
registry entries, and a refresh that fails while the previous source remains
available. Use temporary directories and injected clocks; never read the real
company repository in tests.

Run: `bun test services/registry/src/config.test.ts services/registry/src/catalog.test.ts services/registry/src/source.test.ts`

- [ ] **Step 2: Implement configuration and catalog parsing**

Use the existing strict config pattern and exact defaults:

```typescript
type RegistryConfig = {
  bindHost: string;
  port: number;
  issuer: string;
  companyRoot: string;
  sourceRevision: string;
  refreshSeconds: number;
  maxResponseBytes: number;
};
```

Load `REGISTRY_COMPANY_ROOT` with `@wagglebot/company-config`. Read the
repository-root `tool_catalog.yaml`, optional `company/catalog.yaml` and
`company/registry.yaml`, and each optional
`teams/<group>/{catalog.yaml,registry.yaml}`. Reject the removed flat paths if
they are present so a deployment cannot silently use two layouts. Parse all
catalog files into one normalized snapshot. Reject duplicate entity names,
unknown memberships, and team directories with no matching Group before
constructing a registry. Do not infer identity from Git remotes or file paths.

`RegistrySource.load` reads every file into memory, validates it with the
shared contracts, records `REGISTRY_SOURCE_REVISION` as a required full Git
SHA supplied by the mounted deployment, and returns no live file handles. A
failed read or parse produces `registry_unavailable` and leaves the last
accepted source untouched.

- [ ] **Step 3: Commit source loading**

```bash
git add services/registry/src/config* services/registry/src/catalog* services/registry/src/source*
git commit -m "feat(registry): load validated catalog and registry sources"
```

---

## Task 3: Compose principal-specific effective registries

**Files:**

- Create: `services/registry/src/compose.ts`
- Create: `services/registry/src/compose.test.ts`

**Interfaces:**

- Consumes: `ValidatedSourceSnapshot` and verified `D26Principal`.
- Produces: `composeRegistry(principal, source): RegistrySnapshot`.

- [ ] **Step 1: Write composition tests**

Test:

- a user with no team receives `company/registry.yaml` entries only;
- a user in one team receives the company layer plus that team's entries;
- multiple memberships are sorted lexicographically before shallow override;
- a complete team entry replaces the company entry with the same namespace;
- no field-level deep merge occurs;
- two users receive different effective `revision` values when their proxy
  sets differ;
- identical principal/source inputs produce byte-identical snapshots;
- a literal credential, unpinned package, invalid endpoint, or invalid tool
  catalog prevents publication;
- the principal's groups are read from the catalog snapshot, never from token
  claims or request fields.

Run: `bun test services/registry/src/compose.test.ts`

- [ ] **Step 2: Implement deterministic shallow merge**

```typescript
export function composeRegistry(
  principal: D26Principal,
  source: ValidatedSourceSnapshot,
): RegistrySnapshot {
  const groups = source.catalog.groupsFor(principal.username).toSorted();
  const layers = [source.company, ...groups.map((group) => source.teams.get(group) ?? [])];
  const merged = layers.flat().reduce((entries, entry) => {
    entries.set(entry.namespace, entry);
    return entries;
  }, new Map<string, ProxyConfig>());
  return snapshotFor(principal, source, [...merged.values()].toSorted(byNamespace));
}
```

Use the same merge semantics as Phase 1 provisioning: a complete team entry
replaces a same-namespace company entry. Sort final proxies by namespace and
serialize with stable key ordering before hashing
`sha256("wagglebot:registry:v1\\0" + sourceRevision + "\\0" + principal.username + "\\0" + canonicalJson)`.
The response `revision` is `reg_` plus the full 64-character hash. Do not hash
or log credentials.

Compute the snapshot on demand from the last valid source and memoize it by
`sourceRevision + username`; evict only when a new source revision is accepted.
The principal is trusted only after D26 verification; catalog lookup still
confirms that the user remains registered.

- [ ] **Step 3: Commit composition**

```bash
git add services/registry/src/compose*
git commit -m "feat(registry): compose principal-specific snapshots"
```

---

## Task 4: Expose authenticated registry HTTP

**Files:**

- Create: `services/registry/package.json`
- Create: `services/registry/Dockerfile`
- Create: `services/registry/src/http.ts`
- Create: `services/registry/src/http.test.ts`
- Create: `services/registry/src/index.ts`

**Interfaces:**

- Consumes: `composeRegistry`, `verifyD26SessionToken`, source refresh state,
  and registry contracts.
- Produces: authenticated `GET /registry`, `GET /livez`, and `GET /readyz`.

- [ ] **Step 1: Write HTTP tests**

Test exact behavior:

- missing bearer token returns `401 auth_required`;
- invalid, expired, wrong-issuer, and wrong-audience tokens return
  `401 auth_invalid` without revealing the username;
- a valid token returns only that principal's effective registry;
- query parameters such as `?team=other` and headers such as
  `X-Wagglebot-User` cannot change composition;
- `If-None-Match` returns `304` only for the authenticated caller and matching
  effective revision;
- a source refresh failure keeps serving the last snapshot and `/readyz`
  reports degraded metadata without source paths;
- no valid source exists: `/registry` returns `503 registry_unavailable`;
- response exceeds 256 KiB: return `413 registry_response_too_large` with no
  partial body;
- `/livez` returns `200` without a token and `/readyz` returns `503` until
  source readiness is established;
- logs contain request IDs, revision hashes, and result codes only.

Run: `bun test services/registry/src/http.test.ts`

- [ ] **Step 2: Implement the service**

Create `services/registry/package.json`:

```json
{
  "name": "@wagglebot/registry",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun src/index.ts", "test": "bun test" },
  "dependencies": {
    "@wagglebot/company-config": "workspace:*",
    "@wagglebot/contracts": "workspace:*",
    "@wagglebot/d26-auth": "workspace:*",
    "yaml": "2.8.3",
    "zod": "4.6.1"
  }
}
```

Require `Authorization: Bearer <D26 registry token>`. Verify the token before
reading the `If-None-Match` value or composing a response. Set
`Content-Type: application/json`, `Cache-Control: no-store`, and `ETag` to the
snapshot revision. Return a compact error envelope:

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "auth_invalid",
    "message": "authentication failed",
    "correlationId": "corr_...",
    "retryable": false
  }
}
```

Do not include catalog paths, team names not selected for the caller, source
YAML, or stack traces. Keep source refresh in a background loop; a request may
trigger one bounded refresh only when no valid snapshot exists.

- [ ] **Step 3: Add deployment and commit**

The Docker image runs as a non-root user, mounts the company configuration
repository read-only at `REGISTRY_COMPANY_ROOT`, receives only the D26 issuer
public key, and exposes `/livez` and `/readyz`. It does not mount
`.env.credentials` or any upstream credential.

```bash
git add services/registry
git commit -m "feat(registry): serve authenticated effective registries"
```

---

## Task 5: Prove principal isolation and document the contract

**Files:**

- Create: `services/registry/integration/registry-e2e.test.ts`
- Modify: `deploy/docker-compose.memory.yml`
- Modify: `deploy/README.md`
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Add integration scenarios**

Create a fixture company repository with two users in different groups,
`company/registry.yaml`, two `teams/<group>/registry.yaml` files, and a root
tool catalog. Use signed fixture D26 tokens. Prove:

1. Each user receives the company layer plus only their team layer.
2. A user cannot select another team by request fields.
3. The same namespace override is shallow and deterministic.
4. The removed flat registry paths are rejected and cannot compete with the
   company/team layout.
5. A registry literal credential never appears in a response or persisted
   snapshot.
6. A source revision swap is atomic; concurrent requests see either the old or
   new complete snapshot, never a mixed layer.
7. Invalid refresh retains the last accepted revision.
8. A wrong-audience D26 token is rejected.
9. ETags are principal-specific and authenticated.

Run: `bun test services/registry/integration/registry-e2e.test.ts`

- [ ] **Step 2: Add deployment and API documentation**

Add the registry service to the shared compose profile and document
`REGISTRY_*` variables, the read-only company-repository mount, catalog
revision injection, D26
public-key distribution, refresh behavior, and `/readyz` semantics. Add the
complete `GET /registry` request/response/error/ETag contract to
`docs/api-reference.md`, including the fact that the response is a derived
view and is never a source of credentials.

- [ ] **Step 3: Run full checks and commit**

```bash
bun run check
bun run typecheck
bun test
bun run build
git diff --check
git add services/registry deploy/docker-compose.memory.yml deploy/README.md docs/api-reference.md
git commit -m "feat(registry): verify principal-specific publication"
```

---

## Completion Checklist

- [ ] Registry contracts are shared with Phase 1 CLI validation.
- [ ] D26 registry tokens are verified before composition and request fields
      cannot select identity or team.
- [ ] Catalog membership is authoritative; no `users.yaml` or second identity
      store exists.
- [ ] Company/team registry layers merge shallowly and deterministically using
      only `company/registry.yaml` and `teams/<group>/registry.yaml`.
- [ ] Complete candidate validation occurs before atomic publication.
- [ ] Responses contain no secrets, resolved credentials, trust approvals,
      tokens, local paths, or unselected team data.
- [ ] ETags and revisions are authenticated and principal-specific.
- [ ] Refresh failure preserves the last known-good snapshot.
- [ ] Registry, liveness, readiness, errors, limits, and publication semantics
      are documented in `docs/api-reference.md`.
- [ ] The service uses the common versioned `/livez`, `/readyz`, and error
      envelopes and adds no application requests-per-minute limit.
- [ ] Integration and repository checks pass.
