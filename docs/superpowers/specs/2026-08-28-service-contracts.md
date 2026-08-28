# Service Behavior Contracts

> Companion to the [agentframe design spec](2026-08-28-agentframe-design.md).
> This document gives the behavior contracts for the framework services.
> It also gives a register of known design traps (P-numbers). The
> decisions in the main spec guard against those traps.

## C1. Repo conventions

- Bun workspaces, Biome (2-space, line width 120), strict TS (ES2022,
  bundler resolution), colocated `*.test.ts`, `bun test`.
- Code standards: avoid `try/catch` where possible. Do not use `as`
  casts or `@ts-ignore`. Prefer Bun APIs. Prefer functional array
  methods.
- Config module pattern: a defaults object, and typed coercers that
  throw descriptive errors. `loadConfig(env = process.env)` takes env as
  a parameter, so tests can inject it.
- Service module pattern: `createServer(cfg)` + `createApp(deps)` + an
  `import.meta.main` guard. Tests can then import each module without a
  bound port. Stateless MCP handling: a fresh
  `WebStandardStreamableHTTPServerTransport` + server per request.
- Recipe for a stdio MCP with conflicting dependencies: install the
  wrapped package into an isolated virtualenv or prefix. Invoke it by
  absolute path.
- Release script: tag-based main→production promotion. The script
  refuses a dirty worktree. A cleanup trap removes an unpushed tag and
  restores the original branch.
- CI: OSV scans per lockfile, `bun audit --audit-level high`, image tags
  = short SHA + branch tag, no deploy of a bare `:latest` tag, and a
  `[skip ci]` guard.

## C2. MCP Hub contract

**Proxy config shape** (an entry of `registry.json`):

```typescript
type ProxyConfig = {
  namespace: string;
  mode: "remote_http" | "remote_sse" | "stdio_npx" | "stdio_cmd";
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth?: { scheme: AuthScheme; source: CredentialSource };
};
```

- `stdio_npx` is sugar for `command="npx", args=("-y", package, *args)`.
- Validation: absolute http(s) URLs, and unique namespaces without
  whitespace. Args and env are typed. A config error aborts startup.
- Stdio subprocesses receive an explicit env allow-list plus
  `proxy.env`. They never receive the full parent environment (P22).
  When the host injects credentials via env, list them explicitly per
  proxy.

**Auth scheme and credential source are separate axes (D10).** The
scheme states how to present a credential. The source states where the
hub finds the value. The shared registry carries both, but never a
value.

```typescript
type AuthScheme =
  | { kind: "none" }
  | { kind: "bearer" }                                 // Authorization: Bearer <cred>
  | { kind: "header"; name: string; prefix?: string }  // X-Api-Key: <cred>
  | { kind: "basic"; username: string }                // cred = the password
  | { kind: "env"; map: Record<string, string> };      // stdio only

type CredentialSource =
  | { from: "env"; var: string }        // the normal case
  | { from: "file"; path: string }      // a mounted secret file
  | { from: "literal"; value: string }; // development only, never shared
```

Example registry entry. It contains no secret:

```json
{
  "namespace": "example",
  "mode": "remote_http",
  "endpoint": "https://mcp.example.com/mcp",
  "auth": {
    "scheme": { "kind": "bearer" },
    "source": { "from": "env", "var": "EXAMPLE_TOKEN" }
  }
}
```

**Resolution rules:**

1. Resolve each credential at registration time, on the workstation.
2. Skip a namespace when its credential is absent. Log one clear line.
   Set the namespace status to `error` with a `credential_missing`
   reason. Never abort startup for a missing credential.
3. Never write a resolved value to a log. Log the 12-char fingerprint.
4. Reject a `literal` source when the config came from
   `MCP_HUB_CONFIG_URL`. A shared registry must never carry a secret.

**Stdio credentials use the environment, not OAuth.** The MCP
specification states this directly:

> Implementations using an STDIO transport **SHOULD NOT** follow this
> specification, and instead retrieve credentials from the environment.

Use `{ kind: "env", map: { GITHUB_TOKEN: "$SOURCE" } }` for stdio
upstreams. The hub resolves the source and injects the value into the
subprocess environment.

**A team-wide token needs no new mechanism.** A team token and a
personal token both resolve from an environment variable. Only the
distribution differs. The provisioning tooling distributes the team
token to each workstation.

**Env surface:**

| Env | Default |
|---|---|
| `MCP_HUB_HOST` / `MCP_HUB_PORT` | `0.0.0.0` / `9000` |
| `MCP_HUB_BEARER_TOKEN` | — (required when exposed, D7) |
| `MCP_HUB_CONFIG_PATH` | — (required unless `MCP_HUB_CONFIG_URL` is set) |
| `MCP_HUB_CONFIG_URL` | — (the shared registry; wins over the path) |
| `MCP_HUB_CONFIG_REFRESH_SECONDS` | 900 (0 disables the re-pull) |
| `MCP_HUB_LOG_LEVEL`, `MCP_HUB_DEBUG_HTTP`, `MCP_HUB_DEBUG_MCP` | info / 0 / 0 |
| `MCP_HUB_STARTUP_STRICT` | 0 |
| `MCP_HUB_LIST_TOOLS_CACHE_TTL_SECONDS` | 30 |
| `MCP_HUB_CODE_MODE_ENABLED` | 1 |
| `MCP_HUB_WARMUP_TOOLS_ON_STARTUP` | 1 |
| `MCP_HUB_TOOL_REFRESH_ENABLED` / `_INTERVAL_SECONDS` / `_FAILURE_RETRY_SECONDS` / `_TIMEOUT_SECONDS` / `_MAX_CONCURRENCY` | 1 / 300 / 30 / 5 / 4 |
| `MCP_HUB_TOOL_CATALOG_PATH` | — (operator-supplied) |

**Discovery state machine** (per namespace):
`{status ∈ unknown|refreshing|ready|empty|error, tool_count, tools,
last_attempt_at, last_success_at, last_discovery_error,
consecutive_failures, next_retry_at}`.

Warmup force-refreshes all namespaces. A background loop then refreshes
due namespaces with bounded concurrency and adaptive sleep. A failed
fetch keeps the previous warm cache. Stdio proxies reuse one long-lived
client, so the subprocess does not respawn per call. Remote proxies get
a fresh client per call.

**CodeMode transform:**
- The client-facing surface is only `search`, `get_schema`, `execute`,
  plus the introspection tools. The client never sees the raw downstream
  tools.
- The discovery of the transform must point at the **downstream proxy
  catalog**, not at the transformed server surface. A wrong pointer
  makes search operate on the three transform tools only.
- Catalog names get the prefix `<namespace>_<local_name>`. Strip an
  existing namespace prefix from downstream names first. This prevents
  doubled prefixes such as `github_github_list_issues`.
- Compact each description (first paragraph, 280-char cap). This keeps
  the search index cheap.
- Clients must not stack a second code-execution wrapper on the hub.
- CodeMode off exposes hundreds of raw tools and overloads the client
  context (P10). Keep it on by default.

**Tool catalog schema** (v1, operator-supplied JSON):
`{version, title, overview, platform_context[], operating_principles[],
families[]}`. Each family is `{id, title, namespace_patterns[]
(trailing-* glob), transport, tool_prefixes[], summary, use_for[],
start_with[], avoid[], domain_notes[], examples[], routing_phrases[],
routing_keywords[]}`. Recommendation scores: phrase match +6, keyword
+2, family-id token +3, title word +1.

**Introspection tools:** `list_available_mcps` returns the per-namespace
discovery state, filtered to usable namespaces. `get_tool_catalog`
merges the catalog file with the mounted namespaces and renders
markdown. `recommend_tool_families(task)` ranks families by the scores
above. `get_usage_guide` returns the CodeMode workflow plus the ready
families.

**HTTP client behavior:** timeout 30 s (read 300 s), follow redirects.
Strip the inbound `Authorization` header and substitute the per-proxy
bearer token. Client credentials never leak downstream.

**Startup gating:** register unreachable remote upstreams and heal them
with background refresh. Abort startup on a missing stdio binary.
`MCP_HUB_STARTUP_STRICT=1` also aborts on unreachable remotes (P9).

**Endpoint probe:** a raw TCP connect with a 0.5 s timeout. The probe is
cheap and passes for any listening port. That is good enough.

**Logging:** token fingerprints (12-char SHA-256), sanitized endpoints
(strip userinfo and query), and argument key names only. Values are
never logged.

## C3. Memory worker contract

**Pipeline:**

```
POST /memory/proposals
  → filesystem queue ($MEMORY_STORAGE_ROOT/memory-queue/{queued,running,done,failed})
    → poll loop (3 s) claims via atomic rename(queued→running)
      → LLM extract() → {candidates[], patterns[]}
        → normalize → reconcile against manifest.json / patterns.json
          → preflight Chroma query (skip if content_hash matches and active)
            → shadow-deactivate superseded records → upsert
              → save manifests → complete()
```

**Queue semantics:** a claim is an atomic `rename`, which is safe across
processes. Writes go through `<jobId>.tmp.json` + rename. Job ids sort
lexically, which approximates FIFO. Each job gets 3 attempts. A
malformed job goes to `failed/` with a synthesized record. Garbage
collection removes old entries from `done/` and `failed/`.

**Extraction taxonomy:** durable kinds are
`fact | decision | person | preference`. The `comm_mirror` preference
subtype has a qualifier allow-list. Pattern kinds are
`repeated_question | repeated_blocker | manual_status_work |
missing_doc_candidate | support_gap`. The prompt bans transcripts,
secrets, jokes, and personality inference. Prompt = fixed rules + the
policy file (clipped to 8 k) + the job JSON (clipped to 12 k). The
extraction timeout is 120 s. A non-JSON completion fails the job into
the normal retry path.

**Canonicalization:**
- `canonicalKey = kind:subject:relation:value` (all parts slugged).
  `identityKey = kind:subject:relation` ("same slot, maybe new value").
- `chromaId = sha256(canonicalKey)`.
- A content banlist rejects candidates that contain `secret, token,
  password, api key, ...`.
- Reconcile, same key: merge (max confidence, union of tags and scopes,
  dedup provenance). A structurally-sorted JSON compare makes repeat
  writes idempotent.
- Reconcile, new value in an existing identity slot: the highest
  confidence wins. The loser gets `supersededBy`. The winner gets
  `supersedes`.
- Tombstones in Chroma metadata: `active: 1|0`, `superseded_by`,
  `invalidated_at`, `invalidation_reason`, `content_hash`,
  `provenance_count`.

**Chroma conventions:**
- Collection routing: `episode→memory_episodes`,
  `decision→memory_decisions`, `person→memory_people`, else
  `memory_facts`. Raw episodes go to `memory_episode_drawers`.
- Score = `1/(1+distance)`. The default `minScore` for search is 0.35.
- Chroma metadata may not hold arrays reliably. In that case, fan scopes
  out to `scope_id_0..5` and build `$or` queries. Test the clause cap,
  so extra scopes fail loudly instead of a silent drop (P16). Verify
  whether the Chroma JS client removes the need for this workaround.
- Documents are line-prefixed plain text (`Kind:`, `Title:`, ...). A
  parser reads them back by prefix. This format is fragile but simple.
  It is acceptable.

**`MemoryProvider` seam** — the pipeline depends only on this interface.
Backends are swappable:

```typescript
type MemoryProvider = {
  name: string;
  search(i: MemorySearchInput): Promise<MemorySearchResult>;
  queryRecords(i: MemoryQueryInput): Promise<MemoryRecordHit[]>;
  remember(i: MemoryRememberInput): Promise<MemoryRememberResult>;
  rememberRawEpisode(i: RawEpisodeMemoryInput): Promise<MemoryRememberResult>;
};
```

**Job envelope:**

```
MemoryJob { jobId, reason, sourceKind, sourceId, conversationId,
            scopeIds[], payload, createdAt }
```

Phase 1 ships only the `session_run` proposal path. The envelope is
documented, so runtimes can add richer sources later (P14).

**Policy file contract:** one Markdown file that the operator writes.
The worker injects it verbatim into the extraction prompt. That is the
full format.

## C4. Channel wiring contract

**The architectural spine:**
1. Channel handlers normalize provider payloads into structured inputs
   before dispatch.
2. Business capability goes through the MCP hub. Local tools are
   reserved for channel-bound actions only.
3. Agents never write durable memory directly. They only propose.
4. All durable state lives under one storage root.

**Conversation keys** — the session id IS the routing address. Tools
parse it back to recover their binding:

| Channel | Format |
|---|---|
| Slack | `slack:v1:<teamId>:<channelId>:<threadTs>` (segments URI-encoded) |
| GitHub | `github:v1:owner:<owner>:repo:<repo>:issue:<n>` |
| Webhook | `webhook:<provider>:<eventKey>` |

**Session-bound tools:** channel tools are closures. Each closure is
constructed per session with the conversation key captured. A tool
refuses politely when the key does not parse ("This session is not bound
to a Slack thread."). The LLM therefore cannot post to arbitrary
channels. This gives capability scoping by construction.

**Normalized envelopes** (`ChannelEvent.payload`):
- `slack.app_mention`: `{eventId, teamId, channelId, threadTs, userId, text}`
- `github.issue_comment.created` /
  `github.pull_request_review_comment.created`: `{deliveryId,
  installationId, issue:{owner,repo,issueNumber}, sender,
  comment:{id, threadId?, body}}`
- `webhook.event`: `{provider, body}`

**Dedup keys:** an event without `id`/`eventId`/`deliveryId` gets a
random fallback key. Events therefore never collapse into one
conversation (P13).

**Graceful degradation:** the agent-side hub connection helper returns
zero tools when `MCP_HUB_URL` is unset. The agent still boots.

**Delivery and the responder (D11).** Ingress posts each `ChannelEvent`
to the coordination task board. One responder claims the task. The claim
lease gives exactly one responder per event.

| Rule | Reason |
|---|---|
| Memory is never the event transport | The extractor drops transcripts and runs for up to 120 s. Memory stores facts, not work items (P26). |
| The shared responder handles team channels | A workstation sleeps. Several workstations race. Bot tokens must not spread (D9). |
| The responder replies with a channel-bound tool | The `conversationKey` names the thread. The tool refuses an unparsable key. |
| The responder proposes memory as a side effect | Durable facts still reach memory through the normal path. |

The direct-callback mode (`INGRESS_CALLBACK_URL`) stays available for a
solo engineer. That mode gives no claim semantics.

## C5. Delegated-job vocabulary

The task board (collaboration spec) uses this type vocabulary. It does
not invent new shapes:

`JobSpec {kind, source, prompt, repo, limits {timeoutMs, maxSteps,
maxCostUsd, maxTokens}, model {tier, provider, model}, permissions
{bash, edit, read, network: allow|deny|ask}, mcpBindings[], callbacks[]}`
plus `JobResult`, `JobArtifact`, `JobFailure`, `JobRunRecord`, and a
`JobRunner` interface (`submit/status/cancel/result`).

## C6. Ops (Docker-only)

Agentframe ships containers and a compose file, nothing
platform-specific:

- Each image is overridable via `${*_IMAGE:-...:local}` in compose.
- Plain `depends_on` (no health conditions) is sufficient. The hub
  tolerates unreachable upstreams and heals them with background
  refresh.
- Point load-balancer or orchestrator health checks at the shallow
  `/readyz`. Use a long grace period (~300 s). A slow proxy warmup then
  cannot kill a task. The deep `/health` is for humans and monitoring
  only.
- Model provisioning: `llama-server` downloads by `-hf` ref on the first
  run into a mounted cache volume. No init-container choreography is
  needed.
- Each service documents its full env surface in its README. The compose
  file and `.env.example` are generated views of that. They are never a
  second source of truth.

## C7. Pitfall register

Known design traps and the guard that agentframe applies. The numbering
is stable. The decisions in the main spec reference these.

| # | Trap | Guard |
|---|---|---|
| P2 | Client and server use different env names for the same token | One name per service (D7) |
| P3 | A service without auth relies on positional safety (localhost sidecar) | Bearer required everywhere (D7) |
| P4 | Manifest files are read-modify-write under an in-process lock | Single worker instance per storage root, documented |
| P5 | A worker hard-fails without a local model file, wired through fragile mount choreography | D2 removes in-process model loading entirely |
| P6 | Conflicting policy-path defaults; a missing file degrades to a silent empty policy | One default. A missing file warns at startup |
| P7 | Test seams built from module monkeypatching | Explicit dependency injection |
| P8 | Upstreams registered unconditionally, without config | Zero unconditional proxies |
| P9 | Remote and stdio startup failures treated the same | Deliberate asymmetry: keep unreachable remotes, abort on missing binaries |
| P10 | A disabled CodeMode transform floods clients with raw tools | On by default, documented |
| P11 | Fail-open auth and mixed 401/403 semantics | Fail-closed, 401 (D7) |
| P12 | Dead helpers with formats incompatible with live code | Do not carry dead code |
| P13 | Generic webhooks without ids collapse into one conversation | Random fallback event key |
| P14 | Orphaned payload contracts that nothing produces | Ship only `session_run` and document the envelope |
| P16 | `$or` scope clauses silently truncated | Verify against the Chroma JS client and test scope fan-out |
| P17 | Backend tool names discovered heuristically over MCP | Use the official Chroma client (D3) |
| P18 | Dockerfiles hard-code the workspace package list | Generate or lint the list in CI |
| P19 | Images built with a different package manager than CI tests | One package manager everywhere |
| P20 | Two CI systems drift apart | One CI system |
| P22 | Stdio subprocesses inherit the full parent env | Explicit env allow-list per proxy |
| P23 | A required host directory that is gitignored and undocumented | `./models` documented in README + compose comments |
| P24 | Model ids duplicated across files | Single source in compose/env |
| P25 | A shared hub forwards the caller token to an upstream. The MCP specification forbids this, and it is the confused-deputy attack. | The hub runs local (D9). It strips the inbound `Authorization` header and injects its own resolved credential. |
| P26 | Channel events routed through the memory pipeline. The extractor drops them, adds up to 120 s of latency, and offers no claim semantics. | Ingress posts to the coordination task board (D11). Memory receives facts only. |
| P27 | A secret committed to the shared registry | The registry declares credential *references* only. The hub rejects a `literal` source from a URL-loaded registry. |
| P28 | Two names for two different files, both called "catalog" | `registry.json` lists upstreams. `tool_catalog.json` gives routing advice. |
