# Service Behavior Contracts

> Companion to the [agentframe design spec](2026-08-28-agentframe-design.md).
> Normative behavior contracts for the framework services, plus a
> register of known design traps (P-numbers) that the decisions in the
> main spec guard against.

## C1. Repo conventions

- Bun workspaces, Biome (2-space, line width 120), strict TS (ES2022,
  bundler resolution), colocated `*.test.ts`, `bun test`.
- Code standards: avoid `try/catch` where possible, no `as` casts or
  `@ts-ignore`, prefer Bun APIs, prefer functional array methods.
- Config module pattern: a defaults object, typed coercers that throw
  descriptive errors, and `loadConfig(env = process.env)` taking env as
  a parameter so tests can inject it.
- Service module pattern: `createServer(cfg)` + `createApp(deps)` +
  `import.meta.main` guard, so modules import cleanly in tests without
  binding ports. Stateless MCP handling: a fresh
  `WebStandardStreamableHTTPServerTransport` + server per request.
- Stdio-MCP-with-conflicting-deps recipe: install the wrapped package
  into an isolated virtualenv/prefix and invoke it by absolute path.
- Release script: tag-based main→production promotion with
  dirty-worktree refusal and a cleanup trap that removes an unpushed
  tag and restores the original branch.
- CI: OSV scanning per lockfile, `bun audit --audit-level high`, image
  tags = short SHA + branch tag, never deploy a bare `:latest` tag,
  `[skip ci]` guard.

## C2. MCP Hub contract

**Proxy config shape:**

```
ProxyConfig { namespace, mode, endpoint?, command?, args[], env{}, bearer_token? }
mode ∈ remote_http | remote_sse | stdio_npx | stdio_cmd
```

- `stdio_npx` sugars to `command="npx", args=("-y", package, *args)`.
- Validation: absolute http(s) URLs, non-empty whitespace-free unique
  namespaces, typed args/env; config errors abort startup.
- Stdio subprocesses receive an explicit env allow-list plus
  `proxy.env` — never the full parent environment (P22). Credentials
  the host injects via env must be listed explicitly per proxy.

**Env surface:**

| Env | Default |
|---|---|
| `MCP_HUB_HOST` / `MCP_HUB_PORT` | `0.0.0.0` / `9000` |
| `MCP_HUB_BEARER_TOKEN` | — (required when exposed, D7) |
| `MCP_HUB_CONFIG_PATH` | — (required) |
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
consecutive_failures, next_retry_at}`. Warmup force-refreshes all
namespaces, then a background loop refreshes due namespaces with bounded
concurrency and adaptive sleep. A failed fetch preserves the previous
warm cache. Stdio proxies reuse one long-lived client (no respawn per
call); remote proxies get a fresh client per call.

**CodeMode transform:**
- The client-facing surface is only `search`, `get_schema`, `execute`,
  plus the introspection tools — never the raw downstream tools.
- The transform's discovery must point at the **downstream proxy
  catalog**, not at the transformed server surface — otherwise search
  operates on the transform's own three tools.
- Catalog names are prefixed `<namespace>_<local_name>`; an existing
  namespace prefix on downstream names is stripped first to avoid
  doubled prefixes like `github_github_list_issues`.
- Descriptions are compacted (first paragraph, 280-char cap) to keep the
  search index cheap.
- Clients must not stack a second code-execution wrapper on the hub.
- Disabling CodeMode exposes hundreds of raw tools and blows up client
  context (P10). Keep it default-on.

**Tool catalog schema** (v1, operator-supplied JSON):
`{version, title, overview, platform_context[], operating_principles[],
families[]}` where each family is `{id, title, namespace_patterns[]
(trailing-* glob), transport, tool_prefixes[], summary, use_for[],
start_with[], avoid[], domain_notes[], examples[], routing_phrases[],
routing_keywords[]}`. Recommendation scoring: phrase match +6, keyword
+2, family-id token +3, title word +1.

**Introspection tools:** `list_available_mcps` returns the per-namespace
discovery state filtered to usable namespaces. `get_tool_catalog` merges
the catalog file with mounted namespaces and renders markdown.
`recommend_tool_families(task)` ranks families by the scoring above.
`get_usage_guide` returns the CodeMode workflow plus ready families.

**HTTP client behavior:** timeout 30 s (read 300 s), follow redirects,
strip inbound `Authorization`, substitute the per-proxy bearer — client
credentials never leak downstream.

**Startup gating:** unreachable remote upstreams are registered anyway
and healed by background refresh; missing stdio binaries abort startup.
`MCP_HUB_STARTUP_STRICT=1` also aborts on unreachable remotes (P9).

**Endpoint probe:** raw TCP connect with 0.5 s timeout — cheap, passes
for any listening port. Good enough.

**Logging:** token fingerprints (12-char SHA-256), sanitized endpoints
(strip userinfo and query), argument key names only — never values.

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

**Queue semantics:** claim = atomic `rename` (safe across processes),
writes via `<jobId>.tmp.json` + rename, job ids sort lexically ≈ FIFO,
3 attempts, malformed jobs go to `failed/` with a synthesized record.
`done/` and `failed/` are garbage-collected.

**Extraction taxonomy:** durable kinds
`fact | decision | person | preference`; the `comm_mirror` preference
subtype with a qualifier allow-list; pattern kinds `repeated_question |
repeated_blocker | manual_status_work | missing_doc_candidate |
support_gap`; explicit bans on transcripts, secrets, jokes, and
personality inference. Prompt = fixed rules + policy file (clipped 8 k)
+ job JSON (clipped 12 k). Extraction timeout 120 s. A non-JSON
completion fails the job into the normal retry path.

**Canonicalization:**
- `canonicalKey = kind:subject:relation:value` (all slugged),
  `identityKey = kind:subject:relation` ("same slot, maybe new value").
- `chromaId = sha256(canonicalKey)`.
- Content banlist rejects candidates containing `secret, token,
  password, api key, ...`.
- Reconcile: same key → merge (max confidence, union tags/scopes, dedup
  provenance), structurally-sorted JSON compare for idempotent no-ops.
  New value in an existing identity slot → highest confidence wins,
  loser gets `supersededBy`, winner gets `supersedes`.
- Tombstones in Chroma metadata: `active: 1|0`, `superseded_by`,
  `invalidated_at`, `invalidation_reason`, `content_hash`,
  `provenance_count`.

**Chroma conventions:**
- Collection routing: `episode→memory_episodes`,
  `decision→memory_decisions`, `person→memory_people`, else
  `memory_facts`; raw episodes → `memory_episode_drawers`.
- Score = `1/(1+distance)`, default `minScore` 0.35 for search.
- Chroma metadata may not hold arrays reliably. If so, fan scopes out to
  `scope_id_0..5` and build `$or` queries — and test the clause cap so
  extra scopes fail loudly instead of dropping silently (P16). Verify
  whether the Chroma JS client removes the need for this workaround.
- Documents are line-prefixed plain text (`Kind:`, `Title:`, ...) parsed
  back by prefix. Fragile but simple; acceptable.

**`MemoryProvider` seam** — the pipeline depends only on this interface;
backends are swappable:

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
documented so runtimes can add richer sources later (P14).

**Policy file contract:** one Markdown file the operator writes,
injected verbatim into the extraction prompt. That is the whole format.

## C4. Channel wiring contract

**The architectural spine:**
1. Channel handlers normalize provider payloads into structured inputs
   before dispatch.
2. Business capability goes through the MCP hub; local tools are
   reserved for channel-bound actions only.
3. Agents never write durable memory directly; they only propose.
4. All durable state lives under one storage root.

**Conversation keys** (the session id IS the routing address; tools
parse it back to recover their binding):

| Channel | Format |
|---|---|
| Slack | `slack:v1:<teamId>:<channelId>:<threadTs>` (segments URI-encoded) |
| GitHub | `github:v1:owner:<owner>:repo:<repo>:issue:<n>` |
| Webhook | `webhook:<provider>:<eventKey>` |

**Session-bound tools:** channel tools are closures constructed per
session with the conversation key captured. A tool refuses politely when
the key does not parse ("This session is not bound to a Slack thread.").
The LLM therefore cannot post to arbitrary channels — capability scoping
by construction.

**Normalized envelopes** (`ChannelEvent.payload`):
- `slack.app_mention`: `{eventId, teamId, channelId, threadTs, userId, text}`
- `github.issue_comment.created` /
  `github.pull_request_review_comment.created`: `{deliveryId,
  installationId, issue:{owner,repo,issueNumber}, sender,
  comment:{id, threadId?, body}}`
- `webhook.event`: `{provider, body}`

**Dedup keys:** an event without `id`/`eventId`/`deliveryId` gets a
random fallback key so events never collapse into one conversation (P13).

**Graceful degradation:** the agent-side hub connection helper returns
zero tools when `MCP_HUB_URL` is unset, so the agent still boots.

## C5. Delegated-job vocabulary

The task board (collaboration spec) uses this type vocabulary instead of
inventing new shapes:

`JobSpec {kind, source, prompt, repo, limits {timeoutMs, maxSteps,
maxCostUsd, maxTokens}, model {tier, provider, model}, permissions
{bash, edit, read, network: allow|deny|ask}, mcpBindings[], callbacks[]}`
plus `JobResult`, `JobArtifact`, `JobFailure`, `JobRunRecord`, and a
`JobRunner` interface (`submit/status/cancel/result`).

## C6. Ops (Docker-only)

Agentframe ships containers and a compose file, nothing
platform-specific:

- Every image overridable via `${*_IMAGE:-...:local}` in compose.
- Plain `depends_on` (no health conditions) is sufficient because the
  hub tolerates unreachable upstreams and heals via background refresh.
- Load-balancer or orchestrator health checks target the shallow
  `/readyz` with a generous grace period (~300 s), so slow proxy warmup
  cannot kill a task. Deep `/health` is for humans and monitoring only.
- Model provisioning: `llama-server` downloads by `-hf` ref on first run
  into a mounted cache volume — no init-container choreography needed.
- Each service documents its full env surface in its README; the
  compose file and `.env.example` are generated views of that, never a
  second source of truth.

## C7. Pitfall register

Known design traps and the guard agentframe applies. Numbering is
stable; the main spec's decisions reference these.

| # | Trap | Guard |
|---|---|---|
| P2 | Client and server use different env names for the same token | One name per service (D7) |
| P3 | A service without auth relying on positional safety (localhost sidecar) | Bearer required everywhere (D7) |
| P4 | Manifest files are read-modify-write under an in-process lock | Single worker instance per storage root, documented |
| P5 | A worker that hard-fails without a local model file, wired through fragile mount choreography | D2 removes in-process model loading entirely |
| P6 | Conflicting policy-path defaults; a missing file degrades to a silent empty policy | One default; missing file warns at startup |
| P7 | Test seams built from module monkeypatching | Explicit dependency injection |
| P8 | Upstreams registered unconditionally, without config | Zero unconditional proxies |
| P9 | Treating remote and stdio startup failures the same | Deliberate asymmetry: keep unreachable remotes, abort on missing binaries |
| P10 | Disabling the CodeMode transform floods clients with raw tools | Default-on, documented |
| P11 | Fail-open auth and mixed 401/403 semantics | Fail-closed, 401 (D7) |
| P12 | Dead helpers with formats incompatible with live code | Do not carry dead code |
| P13 | Generic webhooks without ids collapse into one conversation | Random fallback event key |
| P14 | Orphaned payload contracts nothing produces | Ship only `session_run`; document the envelope |
| P16 | `$or` scope clauses silently truncated | Verify against the Chroma JS client; test scope fan-out |
| P17 | Backend tool names discovered heuristically over MCP | Use the official Chroma client (D3) |
| P18 | Dockerfiles hard-code the workspace package list | Generate or lint the list in CI |
| P19 | Images built with a different package manager than CI tests | One package manager everywhere |
| P20 | Two CI systems drifting apart | One CI system |
| P22 | Stdio subprocesses inherit the full parent env | Explicit env allow-list per proxy |
| P23 | A required host directory that is gitignored and undocumented | `./models` documented in README + compose comments |
| P24 | Model ids duplicated across files | Single source in compose/env |
