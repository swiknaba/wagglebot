# Service Behavior Contracts

> Companion to the [wagglebot design spec](2026-08-28-wagglebot-design.md).
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
- Release flow, two halves. `bin/release` (local): refuse a dirty
  worktree or a non-main branch, select major/minor/patch, verify the
  version in `packages/cli/package.json` matches (the bump is a
  reviewed commit), tag, push, create the GitHub release with generated
  notes. A cleanup trap removes the local tag on failure.
  `.github/workflows/release.yml` (CI): on the published release,
  verify tag = package version, then `npm publish --provenance` via
  npm trusted publishing. No npm token exists anywhere. Actions are
  pinned by exact release tag, for example `actions/checkout@v7.0.1` (D13).
- CI: OSV scans per lockfile, `bun audit --audit-level high`, image tags
  = short SHA + branch tag, no deploy of a bare `:latest` tag, and a
  `[skip ci]` guard.

## C2. MCP Hub contract (Phase 2)

**Proxy config shape** (an entry of the `proxies` list in `registry.yaml`):

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
  **The package must carry an exact version**, for example
  `@example/mcp@1.4.2`. The hub rejects an unpinned package, a `latest`
  tag, and a version range. An unpinned entry is a supply-chain risk:
  `npx` would then execute whatever the registry publishes next.
- Prefer `stdio_cmd` with a pre-installed, version-managed binary over
  `stdio_npx`. Reserve `stdio_npx` for pinned, audited packages.
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

```yaml
# registry.yaml
proxies:
  - namespace: example
    mode: remote_http
    endpoint: https://mcp.example.com/mcp
    auth:
      scheme: { kind: bearer }
      source: { from: env, var: EXAMPLE_TOKEN }   # value stays local
```

**Resolution rules:**

1. Resolve each credential at registration time, on the workstation.
2. Skip a namespace when its credential is absent. Log one clear line.
   Set the namespace status to `error` with a `credential_missing`
   reason. Never abort startup for a missing credential.
3. Never write a resolved value to a log. Log the keyed fingerprint
   (see the Logging contract in this section).
4. Reject a `literal` source when the config came from
   `MCP_HUB_CONFIG_URL`. A shared registry must never carry a secret.

**Stdio credentials use the environment, not OAuth.** The MCP
specification states this directly:

> Implementations using an STDIO transport **SHOULD NOT** follow this
> specification, and instead retrieve credentials from the environment.

Use `{ kind: "env", map: { GITHUB_TOKEN: "$SOURCE" } }` for stdio
upstreams. The hub resolves the source and injects the value into the
subprocess environment.

**A team-wide token needs no new mechanism in the hub.** A team token
and a personal token both resolve from an environment variable. Only the
distribution differs. Distribution happens **out of band**: a secret
manager, or the company password manager, into the gitignored
`.env.credentials` file. The provisioning template sync never touches a
secret (guards F23).

**Registry trust policy.** A remote registry selects commands, endpoint
targets, and credential names. A compromised registry is therefore a
code-execution and exfiltration vector, not a config problem (P29).
"Zero credentials on the shared layer" limits the damage of a shared
layer compromise. It does not remove the need for local trust rules:

1. The hub pins the registry origin. It requires HTTPS. It rejects any
   other origin.
2. A remote registry cannot introduce a `stdio_cmd` or `stdio_npx`
   entry, a new command, a new package, a new credential name, or a new
   endpoint origin without **local approval**. The hub records approved
   privileged entries in a local file, `registry.trust.json`.
3. On refresh, an unchanged entry needs no approval. A new or changed
   privileged entry is skipped and logged until an engineer approves it
   (`mcp-hub approve <namespace>`).
4. The hub validates the complete candidate registry first. It then
   swaps atomically. A validation failure keeps the last accepted
   registry (guards F11).
5. A removal on refresh drains the namespace: no new calls, subprocess
   termination after the grace period, cache invalidation.

**Tool descriptions are untrusted input.** The trust policy governs
commands and credentials. It does not govern the descriptive text that
an upstream returns. A tool description reaches the model, so a hostile
upstream can attempt prompt injection through it (P32):

1. Cap the size of each name, description, and schema. Truncate beyond
   the cap.
2. Strip control characters and instruction-like markup from
   descriptions before the model sees them.
3. Tag every tool with its provenance namespace, so the model can tell
   which upstream supplied the text.
4. Treat `tool_catalog.yaml` as first-party content. It is reviewed in
   the central repository, never fetched from an upstream.

**Redirects and private targets.** The hub never forwards a credential
across an origin change. On a cross-origin redirect, it strips the
credential and rejects the redirect unless the trust policy allows the
target origin. Endpoint targets that resolve to private address ranges
require an explicit trust entry. The same rules apply to probes.

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

**Logging:** token fingerprints, sanitized endpoints (strip userinfo and
query), and argument key names only. Values are never logged. A
fingerprint is a 12-char **keyed** hash: HMAC-SHA256 with the
deployment-local `LOG_FINGERPRINT_KEY`. A plain hash prefix would allow
cross-log correlation and offline checks of weak secrets (guards F28).
Without the key, the service omits fingerprints.

## C3. Memory worker contract (Phase 2; component memory is a Phase 1 local file, D29)

**Two write paths, and only one of them ever calls a model.**

**Path 1 — session memory (D24).** The agent extracts, so the worker
receives finished facts:

```
propose_memory({ facts: [...] })   → POST /memory/proposals
  → scrub secrets (server-side, always)
    → filesystem queue ($MEMORY_STORAGE_ROOT/memory-queue/{queued,running,done,failed})
      → poll loop (3 s) claims via atomic rename(queued→running)
        → normalize → reconcile against manifest.json / patterns.json
          → preflight Chroma query (skip if content_hash matches and active)
            → shadow-deactivate superseded records → upsert
              → save manifests → complete()
```

No model call appears in that path, so the old extractor bottleneck is
gone. A backlog can still form under load, but nothing slow blocks a
single write.

**Path 2 — document ingestion — is Phase 4** (D25). Its pipeline
lives in the [phase 4 spec](2026-08-28-phase-4-document-ingestion.md).
It reuses the normalize → reconcile → upsert path above, and every
rule in this section applies to it.

**Path 3 — a human commits a memory directly (D30).** You tell the
agent, and the agent writes it:

```
remember({ text: "We chose Postgres over DynamoDB. The join patterns
                  made a document store expensive.",
           scope: "system:payments-platform" })
```

This path is **explicit**, which changes three things:

1. The agent never judges the importance. You said it, so it is kept.
2. The agent never asks for a promotion confirmation (D22). You named
   the scope.
3. The write happens now, not on a queue.

Everything else still applies. The named scope needs authorization
(D23), the text passes the credential scan (D28), the taxonomy
validates, and a duplicate reconciles instead of adding a record. A
`component` scope writes the local file rather than the store (D29).

`forget({ id })` invalidates one record the same way. It marks the
record dead, and never hard-deletes, so the history stays.

Both reach the agent as MCP tools. `wagglebot remember` and
`wagglebot forget` give the same two operations outside an agent
session.

NOTE: An explicit path fills memory faster than a judged one, because
nothing filters it. That is the intended trade: you asked for the fact,
so you own its value.

**The client is never a security boundary.** Whatever the path, the
server always owns secret scrubbing, canonicalization, deduplication by
content hash, embedding, and storage. A frontier model on a workstation
does not replace any of those.

**Queue semantics:** a claim is an atomic `rename`, which is safe across
processes. Writes go through `<jobId>.tmp.json` + rename. Job ids sort
lexically, which approximates FIFO. Each job gets 3 attempts. A
malformed job goes to `failed/` with a synthesized record. Garbage
collection removes old entries from `done/` and `failed/`.

**Extraction taxonomy.** The same taxonomy governs both paths, so a
memory looks identical whoever extracted it. Durable kinds are
`fact | decision | person | preference`. The `comm_mirror` preference
subtype has a qualifier allow-list. Pattern kinds are
`repeated_question | repeated_blocker | manual_status_work |
missing_doc_candidate | support_gap`. Transcripts, secrets, jokes, and
personality inference are banned.

The worker validates every submitted fact against this taxonomy, and
rejects an unknown kind. Validation is not optional, because the agent
is a client.

**Where the rules live.** The agent extracts session memory, so the
rules must reach the agent: `AGENTS.base.md` carries the taxonomy and
the bans (D24). The server no longer mounts a policy file for the
session path. The `local_llm` ingestion mode still builds a prompt from
fixed rules plus the job JSON (clipped to 12 k), with a 120 s timeout.
A non-JSON completion fails the job into the normal retry path.

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
- **Embeddings use the Chroma built-in default** (D19). The worker sends
  documents, and the server embeds them. Record the embedding metadata
  on each collection at creation time:
  `{provider: "chroma-default", model: "all-MiniLM-L6-v2", dimension:
  384, distance: "cosine", schemaVersion: 1}`.
- The worker compares that metadata at startup. A mismatch aborts
  startup with a message that names the required re-embed. A silent
  dimension change would corrupt every search result.
- **Verify at implementation:** Chroma persists the embedding function
  in the collection configuration since v1.1.13, but some JS client
  versions still require the embedding function on `getCollection`.
  Confirm the behavior of the pinned version before the first write.
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
full format. The worker ships a **built-in default policy**. A missing
file selects the built-in policy and logs a warning. The extraction
policy is therefore never empty and never undefined (guards F32).

**Mutation principals.** `POST /memory/proposals` is the only mutation
on the agent surface. `POST /memories/upsert` and
`POST /memories/invalidate` accept two callers (guards F07, D23):

1. The **administrator principal**. The `wagglebot publish` command is
   the intended caller.
2. A **session token** from the SSH key challenge (D26), checked
   against the catalog. A write to `domain:<name>` requires membership
   in the owner group of that Domain. A write to `org` requires the
   org-owner flag on the User entity. The service reads both from the
   catalog, never from a request field.

The service derives the allowed scopes from the caller, and it rejects
a caller-supplied scope outside that set.

**Credential scan — mandatory on every write (D28).** A leaked token in
a log rotates away. A leaked token in a vector store gets retrieved and
shown to agents for years. The scan therefore runs on **every** write
path: session facts, document ingestion, and human publication. It runs
server-side, because a client is never a security boundary.

Two layers, because one is not enough:

| Layer | Catches | Tool |
|---|---|---|
| Rule scan | Known provider formats: AWS, GitHub, Stripe, and about 150 more | **gitleaks**, a single static binary, pinned by version and checksum (D13) |
| Entropy and banlist | The formats no rule set knows, including internal ones | The built-in check |

Gitleaks is the right tool here. It ships one Go binary, it makes no
network call, and another project maintains the rules. Trufflehog
verifies each finding by calling the provider API, which this service
must not do.

Behavior on a finding:

1. **Redact** each match, and keep the rest of the text. Record the
   count of redactions, the rule identifiers, and the scanner version on
   the record. A false positive costs a few characters.
2. **Reject** the whole write when the text is mostly matches. That is a
   credential dump, not a memory.
3. **Never echo the matched content.** The error names the rule.

**Rescan (D28).** New rules arrive after old memories are stored, so
`wagglebot rescan` walks a collection, applies the current rules, and
invalidates every hit. That command is the only way to fix a miss
already written. It reports the count, and it names no content.

Document ingestion carries the highest risk, because a real runbook or
a Confluence page often contains a real credential. The scan runs
before the extract step, so no credential reaches a model.

The scan also runs before any extractor call. A local extractor keeps
everything inside the deployment. A remote `EXTRACTOR_API_BASE` outside
the deployment **additionally** requires the explicit flag
`EXTRACTOR_ALLOW_EXTERNAL=1` (guards F17, G05).

**Scope model — four scopes, one per catalog level (D22, D23).**

| Scope | Written by | Read by default |
|---|---|---|
| `component:<name>` | Agents, the default target of `propose_memory` | Everyone working in that component |
| `system:<name>` | Agents, after the engineer confirms a promotion | Everyone working in that system |
| `domain:<name>` | Members of the owner group of that Domain | Every system in that domain |
| `org` | Users with the org-owner flag | Everyone |

**Routing of an agent write (D22).** The default target is the
component of the workspace. The extractor classifies each memory:
a fact about this repository stays at `component`, a fact about the
whole project fits `system`. A system classification is a proposal,
never a direct write. The interactive agent asks its engineer in
session: "this looks project-wide, write to `system`?" A background
process never asks, and a timeout falls back to `component`. An
uncertain classification also falls back to `component`. A fact can
land too low, never too high, and the search cascade still finds it.

**Write authorization follows the catalog (D23).** Publication to
`domain` and `org` stays an explicit human command, never a prompt.

* `domain:<name>`: the caller must be a member of the Group that the
  Domain names as `owner`. Membership comes from `Group.spec.members`
  in the catalog.
* `org`: the caller must carry the org-owner flag. The flag is the
  annotation `wagglebot.dev/org-owner: "true"` on the User entity in
  the central catalog. Several users may carry it. Write access to the
  central catalog repository is the permission to grant it, and the
  org owners maintain that repository.

This gate restricts publication into shared curated scopes. It never
restricts collaboration between registered engineers, so D15 holds.

A `memory_search` reads the component of the caller, then its system,
then the domain of that system, then `org`. The cascade matches how
knowledge travels: repository detail stays at the component, a project
shares its facts, a domain shares its conventions, and the
organization shares its interfaces.

**The catalog uses the full [Backstage](https://backstage.io) entity
model (D20).** Wagglebot never infers ownership from a Git remote, a
directory name, or any repository shape.

| Entity | Meaning | Declared in |
|---|---|---|
| **Component** | One software unit. Usually one repository, or one subtree of a repository. | The repository |
| **System** | A set of components that work together. One project. | The central catalog |
| **Domain** | A set of systems that share a business area. | The central catalog |
| **Group** | A team. `parent` gives the hierarchy, so a manager group holds several teams. `members` lists the usernames. | The central catalog |
| **User** | One engineer. `memberOf` mirrors the group membership. The org-owner annotation marks a publication right for the `org` scope. | The central catalog |
| **API** | A published interface of a system. | The repository |

**Ownership is separate from grouping.** Every entity carries an `owner`
that names a Group. That separation is the reason the model survives a
reorganization: a team change edits one `owner` field, and never renames
a domain or a system.

A Domain may therefore equal one team, when the organization works that
way. The model permits that shape without forcing it.

**The format is Backstage YAML, not a private schema.** Wagglebot reads
the entity envelope that Backstage defines. An organization that already
runs Backstage points wagglebot at its existing catalog files, and
writes nothing new.

**The central catalog** holds systems, domains, and groups, as a
multi-document YAML file:

```yaml
# catalog.yaml
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: payments
spec:
  owner: team-payments
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: payments-platform
spec:
  owner: team-payments
  domain: payments
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: team-payments
spec:
  type: team
  parent: platform-group          # subteam hierarchy
  members: [alice, bob]
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations:
    wagglebot.dev/org-owner: "true"   # may publish to the org scope
spec:
  memberOf: [team-payments]
```

Identity lives in **one place**: the catalog. The User entity carries
the username, the public key, the group membership, and the org-owner
flag. No `users.yaml` exists (D26).

**Each repository declares its components.** The component is the unit
of declaration, so the file lives with the code:

```yaml
# catalog-info.yaml  (Backstage standard location)
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: pay-api
spec:
  type: service
  owner: team-payments
  system: payments-platform
```

The loader reads `catalog-info.yaml` first. A team that does not run
Backstage may use `.wagglebot/catalog.yaml` instead, with the identical
schema. The wagglebot path wins when both exist.

YAML also carries comments, which a hand-maintained catalog needs.

Resolution:

1. The declaration file is **authoritative**. Its directory is the root
   of that component. In a repository with several components, place one
   file per component subtree, and the closest enclosing file applies.
2. **There is no inference fallback.**
3. A `system` or `owner` value that the central catalog does not list is
   a **hard error**. The message names the file and the unknown value.

**Without a declaration**, the agent still runs. It gets no component
and no system memory scope. `memory_search` then covers the `org` scope
only, and `propose_memory` returns a clear instruction to add the file.
The agent never invents a scope name (P35).

That model covers every layout, because the component boundary is a team
decision:

| Team layout | Components | Systems |
|---|---|---|
| Microservices | One per service repository | One system holds them all |
| Monorepository, one project | One at the repository root | One system |
| Monorepository, several projects | One per subtree | One system per subtree |
| A team owning several projects | As above | Several systems, one domain |

**Backstage compatibility.** When a repository already carries a
`catalog-info.yaml`, the loader reads it, and maps `spec.system`,
`spec.owner`, and `spec.type` directly. Teams that run Backstage add no
second ownership file. A `.wagglebot/catalog.yaml` wins when both
exist.

Rules:

1. A `memory_search` covers the full cascade of the caller: component,
   system, domain, `org`.
2. An agent never writes to the `domain` or `org` scopes. Agents
   propose to their own component, or to their system after the
   engineer confirms (D22).
3. A read scope selects relevance, never permission (D15). A registered
   engineer may query another component or system scope explicitly.
   Writes to `domain` and `org` are gated by the catalog (D23).
4. The scope of a proposal comes from the **workspace** of the agent,
   never from the team of the author. One engineer works across several
   systems, so the workspace decides the scope. The author identity is
   recorded as provenance.

**Publication into the `domain` and `org` scopes.** Each team
repository may hold one file, `.wagglebot/public.md`. An ingestion job
reads each file and upserts its content into the `org` scope, with the
source `group:<group>`. A domain publication uses the direct endpoints
with a session token, gated by the owner group of that Domain (D23).

* The file states a contract, not a history.
* A pull request reviews each change.
* Re-ingestion replaces the previous records of that source. The team
  therefore controls deletion by editing the file.
* A search finds a published interface by system, by owning group, by
  API name, and by endpoint (G24).
* Publication skips the LLM extractor. The team already wrote the
  facts, so extraction would only add loss.

## C4. Task envelope and delegated-job vocabulary (Phase 3)

NOTE: The task board is Phase 3 (D14). Event-triggered flows left the
MVP, so nothing earlier posts a task. See the
[descoped ideas](2026-08-28-descoped-ideas.md).

Every entry on the task board uses **one versioned envelope**
(guards F06):

```typescript
type Task = {
  taskId: string;
  version: 1;
  kind: "delegated_job";
  system: string;
  branch?: string;
  priority: number;              // default 0
  owner?: string;                // owning group
  eligibility:
    | `owner:${string}`          // one engineer
    | `group:${string}`          // any member of that group
    | `system:${string}`
    | "any";
  requiredCapabilities?: string[];
  idempotencyKey: string;        // dedup key for external effects
  payload: JobSpec;
  result?: JobResult;
  state: "queued" | "claimed" | "done" | "failed" | "cancelled";
  fence: number;                 // monotonic, incremented per claim
};
```

**Claiming, in plain terms.** One agent takes a job so the others skip
it. The claim expires, so a sleeping laptop never blocks a job forever.

| Setting | Value |
|---|---|
| Claim lasts | 90 seconds |
| Heartbeat | Every 30 seconds |
| Attempts | 3 |
| After 3 failures | State `failed`. It stays there for a human. No automatic retry. |
| Cancellation | A queued task cancels at once. A claimed task dies at its next heartbeat. |

Ninety and thirty give three missed heartbeats before a task returns to
the board. One miss is a hiccup. Three is a dead process.

Rules:

1. An agent cannot claim a task outside its eligibility.
2. A claim increments `fence`. Heartbeat and completion must present the
   current `fence`. A stale fence is rejected.
3. Delivery is **at-least-once**. Every external effect deduplicates on
   `idempotencyKey`.

**Why the fence exists.** A laptop wakes an hour late and finishes a
job that another agent already did. The late agent still holds the old
fence number, so the board refuses the work. Without that counter, the
job happens twice.

Never claim exactly-once external behavior. A fence stops a stale
*completion*. It cannot undo an effect the stale worker already sent
(G04, P30).

The `delegated_job` payload uses this vocabulary:

`JobSpec {kind, source, prompt, repo, limits {timeoutMs, maxSteps,
maxCostUsd, maxTokens}, model {tier, provider, model}, permissions
{bash, edit, read, network: allow|deny|ask}, mcpBindings[], callbacks[]}`
plus `JobResult`, `JobArtifact`, `JobFailure`, `JobRunRecord`, and a
`JobRunner` interface (`submit/status/cancel/result`).

## C5. Ops (Docker-only)

Wagglebot ships containers and a compose file, nothing
platform-specific:

- Each image is overridable via `${*_IMAGE:-...:local}` in compose.
- Plain `depends_on` (no health conditions) is sufficient. The hub
  tolerates unreachable upstreams and heals them with background
  refresh.
- Point load-balancer or orchestrator health checks at the shallow
  `/livez`. Use a long grace period (~300 s). A slow proxy warmup then
  cannot kill a task. Point traffic routing at `/readyz`, which reports
  dependency and startup state and returns 503 when the service cannot
  serve (D8). There is no `/health` endpoint.
- Model provisioning: `llama-server` downloads by `-hf` ref on the first
  run into a mounted cache volume. No init-container choreography is
  needed.
- Each service documents its full env surface in its README. The compose
  file and `.env.example` are generated views of that. They are never a
  second source of truth.

## C6. Pitfall register

Known design traps and the guard that wagglebot applies. The numbering
is stable. The decisions in the main spec reference these.

| # | Trap | Guard |
|---|---|---|
| P2 | Client and server use different env names for the same token | One name per service (D7) |
| P3 | A service without auth relies on positional safety (localhost sidecar) | Bearer required everywhere (D7) |
| P4 | Manifest files are read-modify-write under an in-process lock | Single worker instance per storage root, documented |
| P5 | A worker hard-fails without a local model file, wired through fragile mount choreography | D2 removes in-process model loading entirely |
| P6 | Conflicting policy-path defaults; a missing file degrades to a silent empty policy | One default path. A missing file selects the built-in default policy and warns. The policy is never empty. |
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
| P26 | Work items routed through the memory pipeline. Memory stores durable facts and drops transcripts by design, so a work item disappears. It also offers no claim semantics. | A work item goes on the task board. Memory is never the transport for work. |
| P27 | A secret committed to the shared registry | The registry declares credential *references* only. The hub rejects a `literal` source from a URL-loaded registry. |
| P28 | Two names for two different files, both called "catalog" | `registry.yaml` lists upstreams. `tool_catalog.yaml` gives routing advice. |
| P29 | A remote registry treated as plain config. It selects commands, endpoints, and credential names, so a compromise executes code and exfiltrates secrets. | The registry trust policy in §C2: pinned HTTPS origin, local approval for privileged entries, validate-then-swap, keep last accepted. |
| P30 | A claim lease sold as exactly-once. A worker can finish after lease expiry, and a second worker then repeats the job. | At-least-once contract: fencing tokens on claim, heartbeat, and completion, plus idempotency keys on every external effect. |
| P31 | Unpinned executable dependencies: `npx` latest, `:latest` images, unpinned skills. The next publish executes on every workstation. | Exact versions everywhere: `stdio_npx` requires `pkg@x.y.z`, images pin digests, `skills.list` pins revisions. |
| P32 | Upstream tool descriptions treated as trusted text. They reach the model, so a hostile upstream can attempt prompt injection. | Size caps, control-character stripping, provenance tags. The routing catalog stays first-party. |
| P33 | Any assumption about repository layout, and any inference from a Git remote. A repo-per-project rule fragments a microservice team. A repo-as-project rule breaks a monorepository team. | Declare, never derive, in the Backstage style. The central `catalog.yaml` owns the taxonomy. Each repository declares membership. No inference fallback exists (D20). |
| P34 | A scope treated as a security boundary in a trusted-coworker deployment. It creates false confidence and blocks normal cross-team work. | Scopes select defaults and relevance. Git and the identity provider control code access. |
| P35 | A silent fallback that invents an identifier, for example a project name derived from a Git remote. It contradicts catalog validation, and it writes facts into a space that no search covers. | No inference fallback. A missing declaration gives no memory scope, and says so. An unknown value fails loudly. |
