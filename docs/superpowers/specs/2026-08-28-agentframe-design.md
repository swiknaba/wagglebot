# Agentframe Design Spec

> **Related specs:**
> - [Service contracts](2026-08-28-service-contracts.md) — behavior
>   contracts for the hub, the memory worker, and the channels. The
>   pitfall register (P-numbers) is also there.
> - [Cross-machine collaboration](2026-08-28-cross-machine-collaboration-design.md)
>   — the Phase 2 coordination service.
> - [Workstation provisioning](2026-08-28-provisioning-design.md) —
>   the curated skill list and the shared agent base template.

## Problem

Each AI agent that connects to company tools needs the same
infrastructure. This infrastructure includes an MCP aggregation layer,
durable memory, ingress channels, and a composition layer. Teams usually
build this wiring in company-specific monorepos. Vendor services are
hardcoded into the config layer of those monorepos.

We want a **reusable framework** that each team can clone, configure,
and deploy. No team must fork the internals of a different company.

## Goals

1. **MCP Hub** — One `/mcp` endpoint that proxies requests to any number
   of upstream MCP servers. The hub has zero hardcoded upstreams. A
   user-supplied JSON config defines the full surface.
2. **Durable Memory** — An async pipeline that accepts memory proposals.
   An LLM extracts structured facts from each proposal. The pipeline
   stores the facts as vector embeddings for later retrieval.
3. **Pluggable Ingress Channels** — A channel adapter interface. New
   event sources (Slack, GitHub, HTTP webhooks, email, SMS) plug in
   without changes to the core.
4. **Cross-Machine Collaboration** — A coordination layer for agents on
   different machines. Agents discover each other, share memory, and
   hand off tasks. The scope is the project and branch of their humans.
5. **Agent Environment Provisioning** — Shared tooling that installs a
   curated skill set. The same tooling distributes one base instruction
   template across every agent harness on a workstation.
6. **Runtime-Agnostic** — The framework services (hub, memory, channels,
   coordination) run as standalone Docker containers. Any agent runtime
   (LangGraph, raw LLM loops, Claude Code) connects over HTTP/MCP.
7. **Deployment-Agnostic** — Agentframe ships Docker images and a
   compose file, nothing else. The stack runs the same on a laptop, a
   self-hosted box, or any container platform. Development needs no
   cloud accounts. The extraction LLM runs on a CPU.

## Non-Goals

- A specific agent runtime or LLM wrapper.
- Hardcoded support for any SaaS vendor. Users supply those as upstream
  MCP configs.
- A managed cloud platform or a billing layer.
- **Deployment tooling** (Terraform, Helm, cloud-specific IaC). The
  contract ends at containers with documented env vars and health
  endpoints. The operator selects where to run them.

---

## Decisions

| # | Decision |
|---|---|
| D1 | The full stack is **TypeScript (Bun)**. The hub is built on `@modelcontextprotocol/sdk`. |
| D2 | The memory extractor uses **OpenAI-compatible HTTP only**. It does not load models in-process. The compose stack ships a `llama.cpp` server container with a small Qwen GGUF (~1.1 GB, CPU-friendly). A remote endpoint needs only a different `EXTRACTOR_API_BASE` value, no code change. |
| D3 | There is **no MCP wrapper service in front of Chroma**. The memory worker uses the official Chroma JS client. The memory worker also exposes a first-party MCP surface for search and proposals. The hub registers that surface like any upstream (guards P17). |
| D4 | Coordination runs as a **standalone container**. The hub registers it via `config.json` like any other upstream. It never embeds in the hub. |
| D5 | Task board: **FIFO claiming with an optional integer `priority`** (default 0, order `priority DESC, created_at ASC`). No deadlines, no scheduler. Each claim carries a **lease with a heartbeat**. An expired lease returns the task to the board. |
| D6 | Messages are **persistent with replay**: an append-only log, cursor-based replay over SSE (`Last-Event-ID`), a 7-day TTL, and a SQLite store. |
| D7 | **Auth is fail-closed everywhere.** Each service requires a bearer token when one is configured. A network-exposed service refuses to start without one. One env name pattern applies: `<SERVICE>_BEARER_TOKEN` on the server, and the same name on clients (guards P2, P3, P11). |
| D8 | **One health convention:** `GET /readyz` is shallow, always 200, and auth-exempt (the load-balancer target). `GET /health` is deep and returns 503 when the service is not ready. |

---

## Architecture

### Component Map

```
┌──────────────────────────────────────────────────────────────┐
│                       User's Agent                           │
│            (LangGraph, raw loop, Claude Code, ...)           │
│                                                              │
│  connects via:                                               │
│    • MCP_HUB_URL  → mcp-hub (tools, memory, coordination)    │
│    • ingress POSTs ChannelEvents to the agent's callback     │
└────────┬─────────────────────────────────────────────────────┘
         │
    ┌────▼────┐        ┌─────────────┐
    │ mcp-hub │◄───────│   ingress    │──◄── Slack / GitHub /
    │  :9000  │        │    :3030     │      webhooks
    └────┬────┘        └─────────────┘
         │ (all upstreams from config.json)
         ├──────────────┬────────────────┬──────────────────┐
    ┌────▼─────────┐ ┌──▼──────────┐ ┌───▼─────────┐  ┌─────▼─────┐
    │ user-supplied│ │memory-worker│ │coordination │  │    ...    │
    │ MCP upstreams│ │ :3011 (MCP  │ │:3020 (MCP + │  └───────────┘
    └──────────────┘ │  + HTTP)    │ │ SSE, Ph. 2) │
                     └──────┬──────┘ └─────────────┘
                            │
                 ┌──────────┼──────────────┐
            ┌────▼────┐ ┌───▼──────────┐
            │chroma-db│ │extractor-llm │
            │  :8000  │ │(llama.cpp    │
            └─────────┘ │ server :8080)│
                        └──────────────┘
```

### 1. MCP Hub

A TypeScript service on `@modelcontextprotocol/sdk`. It implements the
behaviors below. The [service contracts](2026-08-28-service-contracts.md)
give the details.

- Four proxy modes: `remote_http`, `remote_sse`, `stdio_npx`,
  `stdio_cmd`.
- Config comes only from `MCP_HUB_CONFIG_PATH` (a JSON `proxies` array).
  There are no env-derived vendor defaults and no unconditional proxies.
- The hub injects a per-proxy bearer token. It **strips the inbound
  `Authorization` header** first. Client credentials never leak
  downstream.
- A tool cache with warmup and adaptive background refresh. A failed
  fetch keeps the last good cache.
- A CodeMode-style transform. The client sees only `search`,
  `get_schema`, `execute`, and the introspection tools. The client never
  sees the full downstream tool surface. This transform is the decision
  that makes the hub scale.
- Introspection tools: `list_available_mcps`, `get_tool_catalog`,
  `recommend_tool_families`, `get_usage_guide`. The operator supplies
  the catalog file (`MCP_HUB_TOOL_CATALOG_PATH`). Agentframe ships an
  empty example, never vendor content.
- Startup gating: the hub registers unreachable remote upstreams and
  heals them with background refresh. A missing stdio binary aborts
  startup. `MCP_HUB_STARTUP_STRICT=1` also aborts on unreachable
  remotes.
- Log redaction: token fingerprints (12-char SHA-256), sanitized
  endpoints, and argument key names only. Values are never logged.

The CodeMode transform is the most difficult part. Plan its
implementation explicitly.

### 2. Memory Worker

TypeScript/Bun:

- **Extractor:** an OpenAI-compatible HTTP client (D2). Env:
  `EXTRACTOR_API_BASE`, `EXTRACTOR_API_KEY` (optional),
  `EXTRACTOR_MODEL`. The extraction prompt, the taxonomy, and the 120 s
  timeout follow contracts §C3. The worker parses each completion
  defensively. A non-JSON completion fails the job into the normal retry
  path.
- **Storage:** Chroma via the official JS client (D3). Collection
  routing, tombstone and supersede conventions, and preflight dedup
  follow contracts §C3.
- **Auth:** a bearer token is required (D7).
- **API:** `POST /memory/proposals`, `POST /memories/upsert`,
  `POST /memories/invalidate`, `POST /run-once`, `GET /readyz`, and
  `GET /health`. An MCP surface adds `memory_search`, `memory_query`,
  and `propose_memory`. Agents reach memory through the hub.
- **Queue:** a filesystem state machine (atomic rename claim,
  `queued/running/done/failed`, 3 attempts). Garbage collection removes
  old entries from `done/` and `failed/`.
- **Concurrency:** exactly one worker instance per storage root. The
  manifest files are read-modify-write under an in-process lock (P4).
  Document this limit. Move the manifests to SQLite only when scale
  demands it.
- **Policy:** one Markdown policy file with one default path, mounted at
  `/policy/MEMORY.md`. A missing file causes a startup warning, not a
  silent empty policy (P6).

### 3. Ingress Channels

A standalone HTTP service. Adapters normalize provider payloads into a
common envelope. The service POSTs the envelope to the configured agent
callback URL.

```typescript
type ChannelEvent = {
  id: string;              // dedup key
  source: string;          // "slack", "github", "webhook", ...
  conversationKey: string; // thread/issue/session identity (contracts §C4)
  type: string;            // "slack.app_mention", "github.issue_comment.created"
  payload: unknown;        // normalized event body
  timestamp: string;
};
```

Built-in adapters: `webhook` (shared-secret header, **fail-closed**),
`slack` (Events API, signing-secret verification), and `github` (HMAC
verification). The `conversationKey` formats and the session-bound tool
pattern follow the service contracts (§C4). An event without
`id`/`eventId`/`deliveryId` gets a random fallback key. Events therefore
never collapse into one conversation (P13).

### 4. Coordination (Phase 2)

A standalone MCP + SSE service. It gives agents presence, messaging, and
a task board, scoped by project and branch. The
[cross-machine collaboration spec](2026-08-28-cross-machine-collaboration-design.md)
has the full design.

---

## Repository Structure

```
agentframe/
├── services/
│   ├── mcp-hub/                 # MCP aggregation proxy (TypeScript/Bun)
│   ├── memory-worker/           # Durable memory pipeline (TypeScript/Bun)
│   ├── ingress/                 # Channel adapter service (TypeScript/Bun)
│   └── coordination/            # Cross-machine collab (Phase 2)
├── packages/
│   └── types/                   # Shared types (ChannelEvent, MemoryProvider, JobSpec, ...)
├── provisioning/
│   ├── skills.list              # Curated skill packages
│   ├── bin/install-skills
│   ├── bin/sync-agents
│   └── templates/
│       ├── AGENTS.base.md       # Shared agent base template
│       └── hooks/               # Per-harness hook fragments
├── templates/
│   └── starter/                 # Scaffold for new projects
│       ├── agent/               # Skeleton agent (connects to hub + memory)
│       ├── config.json          # Empty MCP hub config with examples
│       ├── tool_catalog.json    # Empty catalog with one example family
│       └── docker-compose.override.yml
├── models/                      # GGUF cache (gitignored, documented)
├── docker-compose.yml           # Framework stack
├── .env.example
└── README.md
```

---

## Docker Compose — Local Dev Stack

```yaml
services:
  chroma-db:
    image: chromadb/chroma:latest
    ports: ["18000:8000"]

  extractor-llm:
    image: ghcr.io/ggml-org/llama.cpp:server
    command: >
      -hf Qwen/Qwen2.5-1.5B-Instruct-GGUF:q5_k_m
      --host 0.0.0.0 --port 8080 -c 8192
    volumes:
      - ./models:/root/.cache/llama.cpp   # persist downloads

  memory-worker:
    build: ./services/memory-worker
    environment:
      MEMORY_WORKER_PORT: 3011
      MEMORY_WORKER_BEARER_TOKEN: ${MEMORY_WORKER_BEARER_TOKEN}
      EXTRACTOR_API_BASE: http://extractor-llm:8080/v1
      CHROMA_URL: http://chroma-db:8000
      MEMORY_STORAGE_ROOT: /data
    volumes:
      - memory_data:/data
      - ./policy:/policy:ro
    depends_on: [chroma-db, extractor-llm]
    ports: ["3011:3011"]

  mcp-hub:
    build: ./services/mcp-hub
    environment:
      MCP_HUB_PORT: 9000
      MCP_HUB_BEARER_TOKEN: ${MCP_HUB_BEARER_TOKEN}
      MCP_HUB_CONFIG_PATH: /config/config.json
    volumes:
      - ./config.json:/config/config.json:ro
    depends_on: [memory-worker]
    ports: ["9000:9000"]

  ingress:
    build: ./services/ingress
    environment:
      INGRESS_PORT: 3030
      INGRESS_CALLBACK_URL: ${AGENT_CALLBACK_URL}
    ports: ["3030:3030"]

  coordination:                    # Phase 2
    build: ./services/coordination
    profiles: [coordination]
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

There are no vendor-specific services. Users add upstreams via
`config.json`. Users extend the stack via
`docker-compose.override.yml`.

---

## Success Criteria

1. `docker compose up` starts a working stack. The only required
   configuration is an empty `config.json`. The extractor runs on a CPU
   without a model pre-download step.
2. A user adds an upstream MCP server to `config.json` and restarts the
   hub. The new tools appear in `list_available_mcps`.
3. A `POST /memory/proposals` with a fact reaches Chroma after the
   extraction pipeline runs. This works with the bundled llama.cpp
   container. It also works with a remote OpenAI-compatible endpoint,
   with no code change.
4. A webhook event hits the ingress service. The event arrives at the
   agent callback URL as a `ChannelEvent`.
5. `provisioning/bin/sync-agents` writes one rendered template to every
   harness target. `install-skills` installs the curated list on a clean
   machine (see the provisioning spec).
6. (Phase 2) The success criteria in the collaboration spec pass:
   same-project and same-branch agents collaborate, other-branch agents
   are discoverable only, and an expired claim lease returns its task to
   the board.

---

## Open Questions

- Does the Chroma JS client require a scope fan-out workaround for
  array-valued metadata (`scope_id_0..5`, `$or` caps — P16)? Verify
  during implementation.
- Which embedding function does the memory worker use with the Chroma JS
  client: the Chroma default, or the embeddings API of the extractor
  endpoint?

## Parking Lot — Ideas to Discuss

> Captured but not yet designed.

- [ ] _Your ideas go here — tell me what else you have in mind._
