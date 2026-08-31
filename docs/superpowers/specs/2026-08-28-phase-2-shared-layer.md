# Phase 2 — The Shared Layer

> Companion to the [wagglebot design spec](2026-08-28-wagglebot-design.md).
> Phase 2 deploys one shared server for the team: the memory worker
> with Chroma, the SSH auth (D26), registry serving, and the MCP hub as
> the aggregation upgrade (D14).
>
> **Trigger:** a team wants cross-repository memory search, or the tool
> count needs aggregation. Until then, Phase 1 is enough.
>
> Implementation contracts: [§C2 (hub)](2026-08-28-service-contracts.md#c2-mcp-hub-contract-phase-2)
> and [§C3 (memory)](2026-08-28-service-contracts.md).

### 1. MCP Hub (local layer)

A TypeScript service on `@modelcontextprotocol/sdk`. It runs on the
engineer workstation (D9). The
[service contracts](2026-08-28-service-contracts.md) give the details.

- Four proxy modes: `remote_http`, `remote_sse`, `stdio_npx`,
  `stdio_cmd`.
- Config comes from `MCP_HUB_CONFIG_PATH` or `MCP_HUB_CONFIG_URL`. The
  URL form pulls the shared catalog. There are no env-derived vendor
  defaults and no unconditional proxies.
- Each upstream declares an auth **scheme** and a credential **source**
  (D10). The catalog carries both, but never a secret value. The hub
  resolves each value locally, from an environment variable or a file.
- A missing credential skips that namespace. The hub logs one clear line
  and continues. A missing credential never aborts startup.
- The hub injects the resolved credential. It **strips the inbound
  `Authorization` header** first. Caller credentials never travel
  downstream, as the MCP specification requires.
- A tool cache with warmup and adaptive background refresh. A failed
  fetch keeps the last good cache.
- A CodeMode-style transform. The client sees only `search`,
  `get_schema`, `execute`, and the introspection tools. The client never
  sees the full downstream tool surface. This transform is the decision
  that makes the hub scale.
- Introspection tools: `list_available_mcps`, `get_tool_catalog`,
  `recommend_tool_families`, `get_usage_guide`. The operator supplies
  the catalog file (`MCP_HUB_TOOL_CATALOG_PATH`). Wagglebot ships an
  empty example, never vendor content.
- Startup gating: the hub registers unreachable remote upstreams and
  heals them with background refresh. A missing stdio binary aborts
  startup. `MCP_HUB_STARTUP_STRICT=1` also aborts on unreachable
  remotes.
- Log redaction: keyed token fingerprints (contracts §C2), sanitized
  endpoints, and argument key names only. Values are never logged.

The CodeMode transform is the most difficult part. Plan its
implementation explicitly.

### 2. Memory Worker (shared layer)

TypeScript/Bun. The team deploys one instance. Each local hub registers
it as an upstream, so agents reach memory through their own hub.

- **No model on the session write path (D24).** The agent sends
  finished facts. The worker never re-reads a transcript.
- **Server-side duties, because a client is not a security boundary:**
  secret scrubbing, canonicalization, deduplication by content hash,
  embedding, and storage. The worker runs these on every write,
  whatever the source.
- **Document ingestion is Phase 4** (D25). See the
  [phase 4 spec](2026-08-28-phase-4-document-ingestion.md).
- **Storage:** Chroma via the official JS client (D3). Collection
  routing, tombstone and supersede conventions, and preflight dedup
  follow contracts §C3.
- **Auth:** an SSH key challenge issues a session token (D26). Every
  request then carries that token.
- **API:** `POST /memory/proposals` (agents), `POST /memories/upsert`
  and `POST /memories/invalidate` (humans and the publication command,
  gated by the catalog per D23), `POST /run-once`, `GET /livez`, and
  `GET /readyz`. An MCP surface adds `memory_search`, `memory_query`,
  `propose_memory`, `remember`, `forget`, and `ingest_document`. Agents
  reach memory through the hub.
- **Queue:** a filesystem state machine (atomic rename claim,
  `queued/running/done/failed`, 3 attempts). Garbage collection removes
  old entries from `done/` and `failed/`. Session writes pass through
  quickly, because no model call blocks them.
- **Concurrency:** exactly one worker instance per storage root. The
  manifest files are read-modify-write under an in-process lock (P4).
  Document this limit. Move the manifests to SQLite only when scale
  demands it.
- **Memory rules live in the base prompt, not in a server policy file
  (D24).** The agent decides what deserves memory, so the rules must
  reach the agent. `AGENTS.base.md` carries them.
- **Persistence:** named Docker volumes hold Chroma (`/chroma/chroma`)
  and the coordination SQLite file. A volume survives a restart, but
  not a disk loss or a bad migration. The stack therefore ships `dump`
  and `restore` commands for both stores.

### 3. How The Agent Knows Which Upstream To Use

The agent never reads the shared registry. The agent talks only to its
local hub. Two centrally curated files answer the question, and the hub
serves both.

| File | Answers | Shared | Secrets |
|---|---|---|---|
| `registry.yaml` | Which upstreams exist, and how to reach and authenticate each one | Yes | No. It names each credential only. |
| `tool_catalog.yaml` | When to use each family, and what to avoid | Yes | No |

The startup sequence:

1. The hub pulls `registry.yaml` from `MCP_HUB_CONFIG_URL`.
2. The hub resolves each credential locally. It skips any upstream with
   a missing credential.
3. The hub connects to each remaining upstream. It caches the tool
   schemas.
4. The agent connects to the hub. It sees `search`, `get_schema`,
   `execute`, and the introspection tools.

At run time the agent calls `search` for a capability. The hub answers
from its cached schemas. The agent calls `recommend_tool_families` for
routing advice. The hub answers from `tool_catalog.yaml`.

The team therefore curates both the upstream list **and** the routing
advice one time. Each engineer receives both. The remote origin of the
files stays invisible to the agent.

The hub re-pulls the registry on the interval
`MCP_HUB_CONFIG_REFRESH_SECONDS`. Tool schemas refresh on the existing
background cycle.

---

## Docker Compose — Two Profiles

One compose file carries both layers. The `local` profile runs on each
workstation. The `shared` profile runs one time for the team. A solo
engineer starts both profiles on one machine.

NOTE: The block below is **schematic**. It omits the registry serving
and bind-address
hardening. The implemented compose file must start with documented
inputs and must satisfy D7 and D8.

```yaml
services:
  # ── local profile: runs on each engineer workstation ──────────────
  mcp-hub:
    build: ./services/mcp-hub
    profiles: [local]
    environment:
      MCP_HUB_PORT: 9000
      MCP_HUB_BEARER_TOKEN: ${MCP_HUB_BEARER_TOKEN}
      MCP_HUB_CONFIG_URL: ${REGISTRY_URL:-}          # shared registry
      MCP_HUB_CONFIG_PATH: /config/registry.yaml     # fallback
      # Upstream credentials arrive as env vars named by the registry.
      # They stay on this machine.
    env_file:
      - .env.credentials       # gitignored, per engineer
    volumes:
      - ./registry.yaml:/config/registry.yaml:ro
    ports: ["9000:9000"]

  # ── shared profile: deployed one time for the team ────────────────
  chroma-db:
    image: chromadb/chroma@sha256:<pinned-digest>   # never :latest (D13)
    profiles: [shared]
    ports: ["18000:8000"]

  extractor-llm:                   # optional, Phase 4 only (D2, D25)
    image: ghcr.io/ggml-org/llama.cpp:server
    profiles: [ingest]
    command: >
      -hf Qwen/Qwen2.5-1.5B-Instruct-GGUF:q5_k_m
      --host 0.0.0.0 --port 8080 -c 8192
    volumes:
      - ./models:/root/.cache/llama.cpp   # persist downloads

  memory-worker:
    build: ./services/memory-worker
    profiles: [shared]
    environment:
      MEMORY_WORKER_PORT: 3011
      MEMORY_WORKER_BEARER_TOKEN: ${MEMORY_WORKER_BEARER_TOKEN}
      EXTRACTOR_API_BASE: ${EXTRACTOR_API_BASE:-}   # only for batch ingestion
      CHROMA_URL: http://chroma-db:8000
      MEMORY_STORAGE_ROOT: /data
    volumes:
      - memory_data:/data
    depends_on: [chroma-db]
    ports: ["3011:3011"]

  coordination:                    # Phase 3 (D14)
    build: ./services/coordination
    profiles: [collab]
    environment:
      COORD_PORT: 3020
      COORD_BEARER_TOKEN: ${COORD_BEARER_TOKEN}
    volumes:
      - coord_data:/data
    ports: ["3020:3020"]

volumes:
  memory_data:
  coord_data:
```

Start commands:

* Each engineer: `docker compose --profile local up`
* The team deployment: `docker compose --profile shared up`
* One solo engineer: `docker compose --profile local --profile shared up`
* Batch document ingestion (Phase 4): add `--profile ingest`
* Collaboration, in Phase 3: add `--profile collab`

There are no vendor-specific services. Users add upstreams to
`registry.yaml`. Users extend the stack with
`docker-compose.override.yml`.

---

## Operating At Team Scale

This section uses one worked example: five teams, three engineers each,
fifteen engineers total.

### Deployment Shape

| Layer | Count | Holds |
|---|---|---|
| Local hub | 15, one per engineer | That engineer credentials |
| Shared layer | **1**, not one per team | The registry, memory, and (Phase 2) coordination |

Deploy one shared layer, not five. Scoping already separates the teams.
Memory scopes by catalog level.
Five deployments would multiply the operations work by five, for fifteen
people. Five deployments would also block every cross-team benefit.

### Layered Registry

Teams need different upstreams. Compose the registry instead of writing
one file per team:

```
registry.base.yaml      → memory, coordination, org-wide tools (all teams)
registry.team.<team>.yaml → the upstreams of one team
```

The workstation never selects a team by hand. Composition happens in
two places, one per phase:

**Phase 1: locally (D34).** The update command reads `catalog.yaml`
from the central repository, finds the team of the engineer by git
username, merges the layers on the workstation, and writes the result
into each harness config. No server, no auth.

**Phase 2: on the shared layer.** Every hub pulls **one identical
URL**, and the shared layer composes the response from the principal:

```
MCP_HUB_CONFIG_URL=https://shared.internal/registry
Authorization: Bearer <session token>
```

The request carries the session token from the SSH key challenge
(D26). The shared layer reads the group membership of that engineer
from the catalog, and returns `registry.base.yaml` merged with each
`registry.team.<team>.yaml`. The validation command prints the
effective registry.

Both paths produce the identical effective registry, because both run
the identical merge over the identical files.

**The merge is shallow.** A team entry replaces a base entry with the
same namespace, field for field. A team file therefore writes the
complete entry. A deep merge would let a partial entry inherit half its
behavior from another file, and no reader could tell what one namespace
actually does.

Group membership therefore lives in **one place**: the catalog (D23).
Move an engineer to a different group there, and the next registry
refresh delivers the new tool set. No workstation config changes.

The registry selects **which upstreams appear**, for relevance. It is
not a permission gate: local credentials decide which upstream actually
works for one engineer (D15).

The manager curates `registry.base.yaml` one time. Each team lead
curates one team file. No engineer edits a registry.

### Onboarding An Engineer

**Phase 1:** clone the central repository, run `wagglebot update`, and
work. Git access is the whole permission system, so nothing else
exists to configure (D14, D34).

**Phase 2 adds** one value and one pull request. The value is the
shared layer URL, the same for the whole company, shipped in the
provisioning defaults. The pull request adds a User entity with the
username, the public key, and the group membership (D26). No credential
is delivered. The engineer signs in with the SSH key they already have,
and receives a short-lived session token for every shared service.
Upstream MCP credentials stay separate and arrive per upstream (D10).

Offboarding removes the User entity, and in Phase 1 removes the git
access. Run the validation command, and the change takes effect.
Nothing to generate, deliver, or rotate.

### Cross-Team Knowledge

Teams interface with each other. Each team therefore needs a small,
reliable view of the other teams. Memory uses **four scopes**, one per
catalog level (D21–D23).

| Scope | Written by | Visible to | Content |
|---|---|---|---|
| `component:<name>` | Agents, automatically | Everyone in that component | Working memory about one repository |
| `system:<name>` | Agents, after a confirmed promotion | Everyone in that system | Working memory about one project |
| `domain:<name>` | The owner group of that Domain | Every system in that domain | Reviewed domain conventions |
| `org` | Users with the org-owner flag | Every team | The public interface of a team |

A memory search covers the cascade of the caller: component, system,
domain, `org`. One team therefore never reads the working memory of
another team by default.

**Publication is explicit and human-owned.** Each team repository holds
one file, `.wagglebot/public.md`. The team writes the file. The team
reviews each change in a pull request. The shared layer ingests the file
into the `org` scope, with the source `group:<group>`.

The file states the contract of a team, not its history. Good content:

* The endpoints that other teams call, and the authentication for each.
* The events that the team publishes.
* The owner of each system, and the escalation path.
* The decisions that constrain other teams.

NOTE: Automatic summarization of one team memory for other teams looks
attractive, but it fails. The output has no owner, so nobody maintains
it. The compression is lossy, so nobody trusts it. Working memory also
records attempts and dead ends, which help one team and mislead every
other team. A published contract is small, owned, versioned, and
reviewable. Prefer publication.

### Bottlenecks At Fifteen Engineers

| Component | Behavior at 15 | First real limit |
|---|---|---|
| Phase 1 files | No shared state | None |
| Local hubs | No shared state | None |
| Coordination | Small payloads, low rate | Far beyond 15 |
| Memory worker | One instance per storage root. It processes the queue in sequence (P4). No model runs on the write path (D24), so writes stay fast. | Near 50 engineers |

Memory runs asynchronously. A queue backlog delays new facts. A backlog
never blocks an engineer. The optional batch extractor (D2, D25) serves
only bulk ingestion, so a slow batch bothers nobody.

### When To Split The Shared Layer

Split for a hard boundary, never for scale alone:

* One team processes regulated data, and its memory must stay separate.
* One team is external, for example an agency.

### External Parties

An external agency needs stricter access than an internal team. The
design already covers this case. It costs **no new code**.

| Concern | How the design covers it | Cost |
|---|---|---|
| Tool access | Serve the agency its own composed registry, `registry.team.<name>.yaml`. | None. This is the layered registry. |
| Credentials | Credentials already stay on each workstation (D9). The shared layer never held them. | None |
| Memory isolation | Deploy a second shared layer for the agency. | One more deployment. Zero code. |
| Collaboration | The agency uses its own catalog, so its systems and domains stay separate. | None |

Deploy a second shared layer for each external party. Full isolation
then follows from the deployment, not from a permission model.

NOTE: A softer alternative exists. One shared layer could bind each
bearer token to a set of allowed memory scopes. The agency would then
lose access to the `org` scope, but keep its own system scope. That
alternative adds an authorization model to the memory worker.
Wagglebot does not build it. Choose the second deployment instead.

---

## Success Criteria

6. Both profiles start a working stack on one machine. The required
   inputs are an empty `registry.yaml` and the generated service bearer
   tokens (D7). No model download is needed, because no model runs on
   the default path (D24).
7. A user adds an upstream to `registry.yaml` and restarts the hub. The
   new tools appear in `list_available_mcps`.
8. An agent calls `propose_memory` with a fact. The fact passes the
   credential scan (D28), deduplicates, and reaches Chroma. No model
   runs on that path.
9. **Credential scan.** A fact containing an AWS key is redacted before
   storage. A fact that is mostly key material is rejected. Neither
   error message echoes the content.
10. **Direct commit.** An engineer says "remember this for the system".
    The agent calls `remember` with that scope, and the fact is stored
    without a promotion question (D30). A `forget` call on the same
    record removes it from later searches.
11. **Credential isolation.** Two engineers pull the same registry.
    Each hub authenticates as its own engineer. No engineer credential
    and no upstream MCP credential appears in the shared layer, in the
    registry, or in any log. The shared layer holds only its own
    service bearer tokens (D9).
12. **Graceful skip.** An engineer lacks the credential for one
    upstream. That namespace is absent from `list_available_mcps`.
    Every other namespace still works.
13. **Scope isolation.** Team A publishes a fact through
    `.wagglebot/public.md`. Team B finds it in a memory search. Team B
    never finds a working-memory record of Team A.

