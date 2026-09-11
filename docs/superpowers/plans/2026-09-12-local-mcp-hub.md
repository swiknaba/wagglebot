# Local MCP Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` when the work is split into independent tasks) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the workstation-local MCP aggregation hub that loads a trusted registry, isolates each upstream credential, proxies four MCP transports, exposes CodeMode and introspection tools, and remains usable when individual upstreams are unavailable.

**Architecture:** `services/mcp-hub` is a local HTTP MCP server. It authenticates the harness with a local hub bearer token, obtains the principal-specific registry from a local file or the D26-authenticated shared registry, validates trust before swapping configuration, resolves credentials only on the workstation, and manages one upstream client per namespace. The agent sees only `search`, `get_schema`, `execute`, and four introspection tools; raw downstream tool lists never reach the agent.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk` 1.30.0, Zod 4, `@wagglebot/contracts`, `@wagglebot/d26-auth`, native `fetch`, `Bun.spawn`, filesystem APIs, HMAC-SHA256, Bun tests, Biome, and the existing CLI command/config patterns.

**Spec:** §C2 of `docs/superpowers/specs/2026-08-28-service-contracts.md`, the Phase 2 hub requirements in `docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md`, and D1, D7, D9, D10, D13, D26, D32, and D34 in `docs/superpowers/specs/2026-08-28-wagglebot-design.md`.

## Global Constraints

- The hub runs on each engineer workstation. The shared layer never holds engineer credentials or calls vendor MCP servers.
- The HTTP hub requires `MCP_HUB_BEARER_TOKEN`; it is a local caller-to-hub credential and is never sent downstream. `/livez` and `/readyz` are the only unauthenticated endpoints.
- The hub supports exactly `remote_http`, `remote_sse`, `stdio_npx`, and `stdio_cmd`. No unconditional proxy and no vendor-specific default may be added.
- The registry carries credential references, never values. Resolve `env` and `file` sources locally; reject `literal` when the registry came from `MCP_HUB_CONFIG_URL`.
- Strip every inbound `Authorization` header before an upstream call, then inject only the configured per-upstream credential. Never forward the hub bearer or D26 registry token.
- Remote registry URLs must be HTTPS, pinned to the configured origin, and rejected on cross-origin redirects. Private endpoint targets require explicit local approval.
- New/changed commands, packages, credential names, endpoint origins, `stdio_*` entries, and private targets require local approval in `registry.trust.json`. Validate the complete candidate before swapping it into service.
- A missing upstream credential skips that namespace and does not abort startup. A missing stdio executable aborts startup. An unreachable remote is registered as degraded and retried unless `MCP_HUB_STARTUP_STRICT=1`.
- Tool descriptions and schemas are untrusted input. Cap sizes, strip control/instruction-like markup from descriptions, preserve namespace provenance, and treat the first-party routing catalog as trusted only because it is local/reviewed.
- Cap MCP request and response bodies at 1 MiB. Reject an oversized upstream
  result with `hub_response_too_large`; never truncate a structured MCP result.
- Remote tool discovery uses the last known-good cache after failures. Stdio clients are long-lived; remote clients are recreated per call.
- CodeMode is enabled by default. The agent cannot call a downstream tool by raw name; it must search/get schema/execute through the hub catalog.
- Logs contain only namespace, stable status/error, sanitized endpoint origin, argument key names, counts, timings, and optional keyed token fingerprints. Never log credential values, bearer tokens, arguments, descriptions, schemas, or response content.
- Use exact dependency versions, pinned `stdio_npx` package versions, explicit subprocess environment allow-lists, and non-root service execution.
- Add no application requests-per-minute limiter to the workstation-local hub.
  Never automatically retry `execute`; arbitrary upstream mutation and
  idempotency semantics belong to the selected upstream tool.
- Run `bun run check && bun run typecheck && bun test` at every green-tree checkpoint.

## Repository Map

```text
packages/contracts/src/registry.ts
packages/contracts/src/hub.ts
packages/contracts/src/hub.test.ts
packages/contracts/src/index.ts

services/mcp-hub/package.json
services/mcp-hub/Dockerfile
services/mcp-hub/src/config.ts
services/mcp-hub/src/config.test.ts
services/mcp-hub/src/credentials.ts
services/mcp-hub/src/credentials.test.ts
services/mcp-hub/src/trust.ts
services/mcp-hub/src/trust.test.ts
services/mcp-hub/src/registry-client.ts
services/mcp-hub/src/registry-client.test.ts
services/mcp-hub/src/upstream/types.ts
services/mcp-hub/src/upstream/remote-http.ts
services/mcp-hub/src/upstream/remote-sse.ts
services/mcp-hub/src/upstream/stdio.ts
services/mcp-hub/src/upstream/client.test.ts
services/mcp-hub/src/discovery/cache.ts
services/mcp-hub/src/discovery/cache.test.ts
services/mcp-hub/src/discovery/refresh.ts
services/mcp-hub/src/discovery/refresh.test.ts
services/mcp-hub/src/codemode/catalog.ts
services/mcp-hub/src/codemode/catalog.test.ts
services/mcp-hub/src/codemode/tools.ts
services/mcp-hub/src/codemode/tools.test.ts
services/mcp-hub/src/introspection.ts
services/mcp-hub/src/introspection.test.ts
services/mcp-hub/src/mcp/server.ts
services/mcp-hub/src/mcp/server.test.ts
services/mcp-hub/src/index.ts
services/mcp-hub/integration/hub-e2e.test.ts

packages/cli/src/commands/mcp-hub-approve.ts
packages/cli/src/commands/mcp-hub-approve.test.ts
packages/cli/src/index.ts
packages/cli/src/help.ts

deploy/docker-compose.memory.yml
deploy/README.md
docs/api-reference.md
```

---

## Task 1: Define hub-facing contracts and configuration

**Files:**

- Create: `packages/contracts/src/hub.ts`
- Create: `packages/contracts/src/hub.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `services/mcp-hub/src/config.ts`
- Create: `services/mcp-hub/src/config.test.ts`

**Interfaces:**

- Produces: strict schemas for hub config, discovery state, trust records,
  CodeMode inputs/results, introspection results, and stable errors.
- Consumes: canonical `ProxyConfig`, `ToolCatalog`, and `RegistrySnapshot`.

- [ ] **Step 1: Write failing contract tests**

```typescript
test("hub config has no vendor defaults and requires a registry source", () => {
  expect(HubConfigSchema.safeParse({
    host: "127.0.0.1",
    port: 9000,
    bearerToken: "x".repeat(32),
    configPath: "/config/registry.yaml",
    codeModeEnabled: true,
  }).success).toBe(true);
  expect(HubConfigSchema.safeParse({ host: "127.0.0.1", port: 9000, bearerToken: "x".repeat(32) }).success).toBe(false);
});

test("CodeMode exposes only stable tool inputs", () => {
  expect(CodeModeExecuteInputSchema.safeParse({
    tool: "github_list_issues",
    arguments: { state: "open" },
  }).success).toBe(true);
  expect(CodeModeExecuteInputSchema.safeParse({
    tool: "../../secrets",
    arguments: {},
  }).success).toBe(false);
});

test("discovery state is closed and bounded", () => {
  expect(DiscoveryStateSchema.safeParse({
    status: "ready",
    toolCount: 2,
    tools: [],
    lastAttemptAt: null,
    lastSuccessAt: "2026-09-12T12:00:00.000Z",
    consecutiveFailures: 0,
    nextRetryAt: null,
  }).success).toBe(true);
});
```

Add tests for unknown keys, exact transport/auth enums, port/range limits,
absolute config paths, response-size limits, trust fingerprints, stable error
codes, namespace-prefixed tool names, and introspection response caps.

Run: `bun test packages/contracts/src/hub.test.ts services/mcp-hub/src/config.test.ts`

- [ ] **Step 2: Implement contracts and environment loading**

Define these exact config fields and defaults:

```typescript
type HubConfig = {
  host: string;
  port: number;
  bearerToken: string;
  configPath?: string;
  configUrl?: string;
  configRefreshSeconds: number;       // 900; 0 disables remote refresh
  trustPath: string;                   // ~/.wagglebot/mcp-hub/registry.trust.json
  toolCatalogPath?: string;
  startupStrict: boolean;              // false
  listToolsCacheTtlSeconds: number;     // 30
  codeModeEnabled: boolean;             // true
  warmupToolsOnStartup: boolean;        // true
  toolRefreshEnabled: boolean;          // true
  toolRefreshIntervalSeconds: number;   // 300
  toolRetrySeconds: number;             // 30
  toolTimeoutSeconds: number;           // 5
  toolMaxConcurrency: number;            // 4
  logFingerprintKey?: string;
};
```

`MCP_HUB_CONFIG_URL` wins over `MCP_HUB_CONFIG_PATH`; require one source.
Require a bearer token for every HTTP hub instance. Reject a remote URL that is
not HTTPS, and reject an empty or short token. Resolve the default trust path
through the existing Wagglebot state directory helper rather than string-
concatenating `$HOME`.

Define the closed v1 error-code set as `hub_invalid_request`,
`hub_auth_required`, `hub_auth_invalid`, `hub_tool_unavailable`,
`hub_namespace_unavailable`, `hub_upstream_timeout`,
`hub_upstream_invalid_response`, `hub_response_too_large`, and `hub_internal`.

Run: `bun test packages/contracts/src/hub.test.ts services/mcp-hub/src/config.test.ts && bun run check && bun run typecheck`

- [ ] **Step 3: Commit contracts/config**

```bash
git add packages/contracts/src/hub* packages/contracts/src/index.ts services/mcp-hub/src/config*
git commit -m "feat(hub): define local hub contracts and configuration"
```

---

## Task 2: Resolve credentials and enforce local trust approvals

**Files:**

- Create: `services/mcp-hub/src/credentials.ts`
- Create: `services/mcp-hub/src/credentials.test.ts`
- Create: `services/mcp-hub/src/trust.ts`
- Create: `services/mcp-hub/src/trust.test.ts`
- Create: `packages/cli/src/commands/mcp-hub-approve.ts`
- Create: `packages/cli/src/commands/mcp-hub-approve.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/help.ts`

**Interfaces:**

- Produces: `resolveCredential(source, env, fs)`, `TrustStore.load`,
  `TrustStore.requireApproval`, and `approveNamespace`.
- Consumes: `ProxyConfig`, `HubConfig`, and local filesystem state.

- [ ] **Step 1: Write credential and trust tests**

Test:

- `from.env` reads only the named variable;
- `from.file` reads one file, strips one final newline, rejects missing/empty
  values, and never logs the value;
- `from.literal` works only for a local file source explicitly marked
  development, and is rejected for URL-loaded registries;
- stdio env maps receive only the explicit allow-list plus `proxy.env`;
- a new/changed command, package, credential name, endpoint origin,
  `stdio_*` entry, or private target requires approval;
- an unchanged fingerprint needs no new approval;
- an approved entry with changed fingerprint is skipped until re-approved;
- malformed or unsafe `registry.trust.json` fails closed without deleting the
  last valid trust state;
- the CLI approval command prints a diff summary without secrets and stores
  mode `0600` records atomically;
- approval cannot be created from a registry that failed schema validation.

Run: `bun test services/mcp-hub/src/credentials.test.ts services/mcp-hub/src/trust.test.ts packages/cli/src/commands/mcp-hub-approve.test.ts`

- [ ] **Step 2: Implement credential isolation**

```typescript
export type ResolvedCredential = { value: string; fingerprint?: string };

export async function resolveCredential(
  source: CredentialSource,
  input: { registryOrigin: "local" | "remote"; env: Record<string, string | undefined>; readFile: (path: string) => Promise<string> },
): Promise<ResolvedCredential | null>;
```

Validate environment names as `^[A-Z][A-Z0-9_]{0,127}$`; validate file paths
with the configured secret-file policy; and never pass the parent environment
to a child. For `auth.scheme.kind === "env"`, resolve each source and construct
only the declared child environment keys.

- [ ] **Step 3: Implement trust records and approval command**

Store:

```typescript
type TrustRecord = {
  namespace: string;
  fingerprint: string;
  privilegedKinds: Array<"command" | "package" | "credential" | "origin" | "private_target">;
  approvedAt: string;
};
```

Fingerprint canonical privileged fields with
`sha256("wagglebot:hub-trust:v1\\0" + canonicalJson)`. The CLI command
`wagglebot mcp-hub approve <namespace>` loads and validates the current
registry, displays only namespace/kind/origin/package metadata, and writes the
record atomically after explicit confirmation from the command caller. The
hub never auto-approves a changed privileged entry.

Run: `bun test services/mcp-hub/src/credentials.test.ts services/mcp-hub/src/trust.test.ts packages/cli/src/commands/mcp-hub-approve.test.ts && bun run check && bun run typecheck`

- [ ] **Step 4: Commit the trust boundary**

```bash
git add services/mcp-hub/src/credentials* services/mcp-hub/src/trust* packages/cli/src/commands/mcp-hub-approve* packages/cli/src/index.ts packages/cli/src/help.ts
git commit -m "feat(hub): isolate credentials and require registry trust approvals"
```

---

## Task 3: Fetch, validate, refresh, and atomically swap registries

**Files:**

- Create: `services/mcp-hub/src/registry-client.ts`
- Create: `services/mcp-hub/src/registry-client.test.ts`

**Interfaces:**

- Consumes: local file or D26-authenticated remote registry, trust store,
  registry contracts.
- Produces: `RegistryManager.current()`, `.refresh()`, `.start()`, `.stop()`,
  and a validated snapshot with source metadata.

- [ ] **Step 1: Write refresh tests**

Test:

- local path is loaded and validated;
- remote fetch uses a D26 `wagglebot-registry` token and no hub/upstream token;
- `Authorization` is present only on the registry request;
- cross-origin redirects are rejected and never receive credentials;
- unchanged `ETag` keeps the current snapshot;
- malformed/oversized/unauthorized responses retain the last good snapshot;
- a changed privileged entry is accepted into a candidate but its namespace
  is skipped until approval;
- removal drains the namespace and invalidates its discovery cache;
- refresh runs at 900 seconds, never overlaps itself, and stops cleanly.

Run: `bun test services/mcp-hub/src/registry-client.test.ts`

- [ ] **Step 2: Implement the manager**

```typescript
export type RegistryManager = {
  current(): RegistrySnapshot;
  refresh(signal?: AbortSignal): Promise<RefreshResult>;
  start(): void;
  stop(): Promise<void>;
};
```

For a remote source, pin the origin from the configured URL, use a bounded
30-second fetch, accept only JSON matching `RegistrySnapshotSchema`, enforce a
256 KiB response cap, and pass the D26 token only to the registry endpoint.
For a local source, require file mode `0600` or stricter when it contains
registry data and validate before use. Build a candidate manager state, run
trust checks and credential resolution, then swap the complete state in one
assignment. Keep the last good state on any failure.

Use `AbortController` for refresh cancellation. Expose only namespace status,
revision, and counts to logs; never log the snapshot.

- [ ] **Step 3: Commit registry refresh**

```bash
git add services/mcp-hub/src/registry-client*
git commit -m "feat(hub): refresh trusted local and remote registries"
```

---

## Task 4: Implement four upstream transports with credential stripping

**Files:**

- Create: `services/mcp-hub/src/upstream/types.ts`
- Create: `services/mcp-hub/src/upstream/remote-http.ts`
- Create: `services/mcp-hub/src/upstream/remote-sse.ts`
- Create: `services/mcp-hub/src/upstream/stdio.ts`
- Create: `services/mcp-hub/src/upstream/client.test.ts`

**Interfaces:**

- Consumes: validated `ProxyConfig`, resolved local credentials, MCP SDK 1.30.0.
- Produces: `UpstreamClient.initialize`, `.listTools`, `.callTool`, `.close`,
  and `UpstreamManager` lifecycle/drain operations.

- [ ] **Step 1: Write transport tests**

Test:

- HTTP and SSE clients inject the configured credential and remove inbound
  `Authorization`;
- bearer/header/basic schemes produce the exact expected downstream header;
- cross-origin redirects strip the credential and fail unless the destination
  is explicitly trusted;
- HTTP timeout is 30 seconds, read timeout is 300 seconds;
- stdio `npx` requires an exact `package@x.y.z`, never `latest`/range;
- stdio receives an explicit environment allow-list and never the parent env;
- missing stdio binary is fatal at startup;
- remote connection failure creates a degraded namespace, not a startup failure;
- one long-lived stdio client is reused and terminated after a removal grace
  period; remote clients are fresh per call;
- all response/tool data remains out of logs.

Run: `bun test services/mcp-hub/src/upstream/client.test.ts`

- [ ] **Step 2: Implement the transport adapters**

Use the official MCP SDK transports:

```typescript
export type UpstreamClient = {
  initialize(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<McpToolSchema[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
};
```

Use `StreamableHTTPClientTransport` for `remote_http`, `SSEClientTransport`
for `remote_sse`, and `StdioClientTransport` for stdio modes. Wrap remote fetch
to remove inbound authorization, inject only the resolved per-proxy auth, cap
redirects, and validate destination origin before forwarding credentials.

For `stdio_npx`, parse `command`/package from the pinned args and reject
anything that is not an exact semver package reference. Prefer the configured
preinstalled absolute binary for `stdio_cmd`. Spawn with an explicit env map
and a sanitized working directory; do not use a shell.

- [ ] **Step 3: Commit transport adapters**

```bash
git add services/mcp-hub/src/upstream
git commit -m "feat(hub): add isolated HTTP SSE and stdio upstream transports"
```

---

## Task 5: Add discovery cache and adaptive refresh

**Files:**

- Create: `services/mcp-hub/src/discovery/cache.ts`
- Create: `services/mcp-hub/src/discovery/cache.test.ts`
- Create: `services/mcp-hub/src/discovery/refresh.ts`
- Create: `services/mcp-hub/src/discovery/refresh.test.ts`

**Interfaces:**

- Consumes: `UpstreamManager` and current registry state.
- Produces: per-namespace `DiscoveryState`, warm cache, and refresh scheduler.

- [ ] **Step 1: Write cache/state tests**

Use the exact state shape:

```typescript
type DiscoveryState = {
  status: "unknown" | "refreshing" | "ready" | "empty" | "error";
  toolCount: number;
  tools: McpToolSchema[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastDiscoveryError: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
};
```

Test warmup, cache TTL 30 seconds for list responses, bounded concurrency of
four, success reset, exponential/adaptive retry, last-good retention on error,
empty upstreams, remote unreachable startup, strict startup failure, namespace
removal/drain, and cancellation on shutdown.

Run: `bun test services/mcp-hub/src/discovery`

- [ ] **Step 2: Implement the scheduler**

Warmup calls `listTools` for every approved/credentialed namespace when enabled.
A background loop refreshes due namespaces every 300 seconds, retries failures
after 30 seconds, and never runs more than four concurrent discoveries. Store
only sanitized tool metadata and the discovery state; raw call results are not
cached. Preserve the last good tool list when a refresh fails, but mark the
namespace `error` and increment `consecutiveFailures`.

- [ ] **Step 3: Commit discovery**

```bash
git add services/mcp-hub/src/discovery
git commit -m "feat(hub): cache and refresh upstream tool schemas"
```

---

## Task 6: Implement CodeMode and introspection tools

**Files:**

- Create: `services/mcp-hub/src/codemode/catalog.ts`
- Create: `services/mcp-hub/src/codemode/catalog.test.ts`
- Create: `services/mcp-hub/src/codemode/tools.ts`
- Create: `services/mcp-hub/src/codemode/tools.test.ts`
- Create: `services/mcp-hub/src/introspection.ts`
- Create: `services/mcp-hub/src/introspection.test.ts`

**Interfaces:**

- Consumes: discovery cache, the validated `RegistrySnapshot.toolCatalog` or
  local-fallback `tool_catalog.yaml`, and upstream `McpToolSchema` values.
- Produces: `search`, `get_schema`, `execute`,
  `list_available_mcps`, `get_tool_catalog`, `recommend_tool_families`, and
  `get_usage_guide` handlers.

- [ ] **Step 1: Write catalog/search tests**

Test:

- tool names are `<namespace>_<local_name>` with an existing namespace prefix
  stripped before adding the canonical prefix;
- descriptions keep only the first paragraph and 280 characters;
- control characters and instruction-like markup are removed;
- every result retains its namespace provenance;
- phrase match scores +6, keyword +2, family-id +3, and title word +1;
- `search` never returns raw downstream tool definitions;
- `get_schema` returns one bounded schema for a known prefixed tool;
- unknown/removed tools fail with stable `hub_tool_unavailable`;
- `execute` calls only a currently ready namespace/tool and returns the
  downstream result without logging arguments or content;
- a second CodeMode wrapper is not exposed.

Run: `bun test services/mcp-hub/src/codemode services/mcp-hub/src/introspection.test.ts`

- [ ] **Step 2: Implement the CodeMode catalog**

Normalize each cached tool to:

```typescript
type HubTool = {
  qualifiedName: string;
  namespace: string;
  localName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
```

Reject schemas over 64 KiB and names over 120 characters. `search` accepts a
query of at most 500 Unicode code points and returns at most 20 metadata
results. `get_schema` returns one schema at most 64 KiB. `execute` accepts a
known qualified name and JSON object arguments; it rejects path-like tool
names, unknown namespaces, and unavailable discovery states before calling the
upstream. Validate the returned `CallToolResult`, reject a serialized result
over 1 MiB with `hub_response_too_large`, and never retry the call. Do not allow
a caller to select a command, endpoint, credential, or raw transport.

- [ ] **Step 3: Implement introspection**

Implement exact bounded outputs:

- `list_available_mcps`: usable namespace/status/count metadata;
- `get_tool_catalog`: first-party catalog merged with ready namespace data,
  rendered Markdown, at most 32 KiB;
- `recommend_tool_families(task)`: deterministic family ranking using the
  documented weights;
- `get_usage_guide`: CodeMode workflow plus ready families, at most 16 KiB.

Treat the registry snapshot's tool catalog as reviewed first-party content. A
file-backed hub may instead load the existing root `tool_catalog.yaml` through
the same shared `ToolCatalogSchema`. Reject an invalid catalog without
replacing the last accepted one; do not introduce a second JSON catalog format.

- [ ] **Step 4: Commit CodeMode/introspection**

```bash
git add services/mcp-hub/src/codemode services/mcp-hub/src/introspection*
git commit -m "feat(hub): expose CodeMode and MCP introspection"
```

---

## Task 7: Wire the MCP server and prove full hub behavior

**Files:**

- Create: `services/mcp-hub/src/mcp/server.ts`
- Create: `services/mcp-hub/src/mcp/server.test.ts`
- Create: `services/mcp-hub/src/index.ts`
- Create: `services/mcp-hub/integration/hub-e2e.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `deploy/docker-compose.memory.yml`
- Modify: `deploy/README.md`
- Modify: `docs/api-reference.md`

**Interfaces:**

- Consumes: registry manager, credentials/trust, upstream/discovery, CodeMode,
  introspection, and MCP SDK 1.30.0.
- Produces: authenticated `/mcp`, `/livez`, and `/readyz` endpoints.

- [ ] **Step 1: Write MCP server tests**

Test:

- missing/invalid local hub bearer is rejected;
- request or upstream result over 1 MiB is rejected without partial content;
- only the seven documented tools are visible;
- raw downstream tools are never registered;
- `search`, `get_schema`, `execute`, and introspection tools route correctly;
- a namespace outage affects only that namespace;
- startup strictness matches remote/stdio asymmetry;
- shutdown drains clients and stops refresh loops;
- `/livez`, `/readyz`, and known failures use the versioned envelopes from
  `docs/api-reference.md`;
- response sizes and errors are bounded and redacted.

Run: `bun test services/mcp-hub/src/mcp/server.test.ts`

- [ ] **Step 2: Implement the server and lifecycle**

Use `WebStandardStreamableHTTPServerTransport` with a fresh MCP server per
request, as required by the service conventions. Authenticate the local hub
bearer before creating a transport. Register only:

```text
search
get_schema
execute
list_available_mcps
get_tool_catalog
recommend_tool_families
get_usage_guide
```

Construct the registry manager, trust store, credential resolver, upstream
manager, discovery scheduler, and CodeMode handlers from injected dependencies.
On EOF/SIGTERM/SIGINT, abort refreshes, drain removed namespaces, close all
stdio/remote clients, and close the MCP server exactly once.

- [ ] **Step 3: Add integration scenarios**

Use fake HTTP/SSE servers and a real temporary stdio fixture. Prove:

1. Four transport modes work with the correct per-upstream credential.
2. The hub bearer and D26 registry token never reach an upstream.
3. Missing credentials skip only one namespace.
4. Remote failure keeps last-good schemas; missing stdio binary fails startup.
5. A changed remote registry entry waits for local approval.
6. Cross-origin redirect and private target are rejected without credential
   forwarding.
7. CodeMode search/schema/execute and all introspection tools work without raw
   tool exposure.
8. Descriptions are sanitized and provenance remains visible.
9. Logs contain no credentials, tokens, argument values, or response content.

Run: `bun test services/mcp-hub/integration/hub-e2e.test.ts`

- [ ] **Step 4: Add deployment/API docs and run gates**

Add the local-profile hub service, explicit `.env.credentials` handling,
loopback binding, health checks, read-only registry/catalog mounts, and D26
registry-client configuration to `deploy/docker-compose.memory.yml`. Document
trust approval, credential sources, refresh, CodeMode, and shutdown behavior in
`deploy/README.md`. Add every MCP tool schema and hub error/limit contract to
`docs/api-reference.md`.

Run:

```bash
bun run check
bun run typecheck
bun test
bun run build
git diff --check
```

- [ ] **Step 5: Commit the hub**

```bash
git add services/mcp-hub packages/cli/src/index.ts packages/cli/src/help.ts deploy/docker-compose.memory.yml deploy/README.md docs/api-reference.md
git commit -m "feat(hub): deliver secure local MCP aggregation"
```

---

## Completion Checklist

- [ ] Four upstream transports work with isolated local credentials.
- [ ] The hub never forwards inbound hub/D26 credentials downstream.
- [ ] Registry origin, redirects, private targets, commands, packages, and
      credential names obey local approval policy.
- [ ] Last-good discovery survives remote failure; startup asymmetry is exact.
- [ ] Tool schemas/descriptions are bounded, sanitized, and provenance-tagged.
- [ ] CodeMode and four introspection tools are the only client-facing surface.
- [ ] Local bearer authentication, redacted logs, and bounded errors work.
- [ ] Registry refresh, tool refresh, shutdown, and namespace draining are
      deterministic and test-covered.
- [ ] Deployment and API contracts are documented.
- [ ] Full repository checks pass.
