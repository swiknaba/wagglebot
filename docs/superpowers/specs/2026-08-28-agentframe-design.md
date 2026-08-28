# Agentframe Design Spec

> **Related specs:**
> - [Service contracts](2026-08-28-service-contracts.md) — normative
>   behavior contracts for the hub, memory worker, and channels, plus
>   the pitfall register (P-numbers referenced below).
> - [Cross-machine collaboration](2026-08-28-cross-machine-collaboration-design.md)
>   — Phase 2 coordination service.
> - [Workstation provisioning](2026-08-28-provisioning-design.md) —
>   curated skills + shared agent base template.

## Problem

Building an AI agent that connects to company tools requires the same
infrastructure every time: an MCP aggregation layer, durable memory,
ingress channels, and a way to compose them. Teams typically build that
wiring inside company-specific monorepos, with vendor services hardcoded
into the config layer.

We want a **reusable framework** that any team can clone, configure, and
deploy — without forking anyone's internals.

## Goals

1. **MCP Hub** — A single `/mcp` endpoint that proxies requests to any
   number of upstream MCP servers. Zero hardcoded upstreams; the entire
   surface comes from a user-supplied JSON config.
2. **Durable Memory** — An async pipeline that accepts memory proposals,
   extracts structured facts via an LLM, and stores them as vector
   embeddings for later retrieval.
3. **Pluggable Ingress Channels** — A channel adapter interface so new
   event sources (Slack, GitHub, HTTP webhooks, email, SMS) plug in
   without touching the core.
4. **Cross-Machine Collaboration** — A coordination layer that lets
   agents on different machines discover each other, share memory, and
   hand off tasks — scoped to the project and branch their humans work on.
5. **Agent Environment Provisioning** — Shared tooling that installs a
   curated skill set and distributes one base instruction template across
   every agent harness on a workstation.
6. **Runtime-Agnostic** — The framework services (hub, memory, channels,
   coordination) run as standalone Docker containers. Any agent runtime
   (LangGraph, raw LLM loops, Claude Code) connects over HTTP/MCP.
7. **Deployment-Agnostic** — Agentframe ships Docker images and a
   compose file, nothing else. It runs the same on a laptop, a
   self-hosted box, or any container platform. No cloud accounts
   required for development. The extraction LLM runs on CPU.

## Non-Goals

- Shipping a specific agent runtime or LLM wrapper.
- Hardcoded support for any SaaS vendor. Those become user-supplied
  upstream MCP configs.
- A managed cloud platform or billing layer.
- **Deployment tooling** (Terraform, Helm, cloud-specific IaC). The
  contract ends at "everything is a container with documented env vars
  and health endpoints." Where to run them is the operator's choice.

---

## Decisions

| # | Decision |
|---|---|
| D1 | The whole stack is **TypeScript (Bun)**. The hub is built on `@modelcontextprotocol/sdk`. |
| D2 | The memory extractor speaks **OpenAI-compatible HTTP only** — no in-process model loading. The compose stack ships a `llama.cpp` server container with a small Qwen GGUF (~1.1 GB, CPU-friendly). Pointing `EXTRACTOR_API_BASE` at any remote endpoint needs no code change. |
| D3 | There is **no MCP wrapper service in front of Chroma**. The memory worker talks to Chroma through the official Chroma JS client. Memory search/propose is exposed to agents as a first-party MCP surface on the memory worker, registered in the hub like any upstream (guards P17). |
| D4 | Coordination runs as a **standalone container**, registered in the hub via `config.json` like any other upstream. It never embeds in the hub. |
| D5 | Task board: **FIFO claiming with an optional integer `priority`** (default 0, order `priority DESC, created_at ASC`). No deadlines, no scheduler. Claims carry a **lease with heartbeat**; an expired lease returns the task to the board. |
| D6 | Messages are **persistent with replay**: append-only log, cursor-based replay over SSE (`Last-Event-ID`), 7-day TTL, SQLite store. |
| D7 | **Auth is fail-closed everywhere.** Every service requires a bearer token when one is configured and refuses to start in network-exposed mode without one. One env name pattern: `<SERVICE>_BEARER_TOKEN` on the server, and the same name on clients (guards P2, P3, P11). |
| D8 | **One health convention:** `GET /readyz` is shallow, always 200, auth-exempt (the load-balancer target). `GET /health` is deep and returns 503 when not ready. |

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

A TypeScript service on `@modelcontextprotocol/sdk`. It implements these
behaviors (details in the
[service contracts](2026-08-28-service-contracts.md)):

- Four proxy modes: `remote_http`, `remote_sse`, `stdio_npx`, `stdio_cmd`.
- Config comes only from `MCP_HUB_CONFIG_PATH` (JSON `proxies` array).
  There are no env-derived vendor defaults and no unconditional proxies.
- Per-proxy bearer injection with **inbound `Authorization` stripping**
  so client credentials never leak downstream.
- Tool cache with warmup, adaptive background refresh, and
  keep-last-good-cache on fetch failure.
- A CodeMode-style transform: the client sees only `search`,
  `get_schema`, `execute`, plus the introspection tools — never the full
  downstream tool surface. This is the load-bearing scalability decision.
- Introspection tools: `list_available_mcps`, `get_tool_catalog`,
  `recommend_tool_families`, `get_usage_guide`. The catalog file is
  operator-supplied (`MCP_HUB_TOOL_CATALOG_PATH`); agentframe ships an
  empty example, never vendor content.
- Startup gating: unreachable remote upstreams are registered anyway and
  healed by background refresh; missing stdio binaries abort startup.
  `MCP_HUB_STARTUP_STRICT=1` also aborts on unreachable remotes.
- Redaction discipline in logs: token fingerprints (12-char SHA-256),
  sanitized endpoints, argument key names only — never values.

Hairiest part: the CodeMode transform. Budget for it explicitly.

### 2. Memory Worker

TypeScript/Bun:

- **Extractor:** OpenAI-compatible HTTP client (D2). Env:
  `EXTRACTOR_API_BASE`, `EXTRACTOR_API_KEY` (optional), `EXTRACTOR_MODEL`.
  Extraction prompt, taxonomy, and 120 s timeout per contracts §C3. The
  completion is parsed defensively; a non-JSON completion fails the job
  into the normal retry path.
- **Storage:** Chroma via the official JS client (D3). Collection
  routing, tombstone/supersede conventions, and preflight dedup per
  contracts §C3.
- **Auth:** bearer token required (D7).
- **API:** `POST /memory/proposals`, `POST /memories/upsert`,
  `POST /memories/invalidate`, `POST /run-once`, `GET /readyz`,
  `GET /health` — plus an MCP surface exposing `memory_search`,
  `memory_query`, and `propose_memory`, so agents reach memory through
  the hub.
- **Queue:** a filesystem state machine (atomic rename claim,
  `queued/running/done/failed`, 3 attempts) with garbage collection for
  `done/` and `failed/`.
- **Concurrency:** exactly one worker instance per storage root. The
  manifest files are read-modify-write under an in-process lock (P4).
  Document this. Move manifests to SQLite only when scaling demands it.
- **Policy:** one Markdown policy file, one default path, mounted at
  `/policy/MEMORY.md`. A missing file is a startup warning, not a silent
  empty policy (P6).

### 3. Ingress Channels

Standalone HTTP service. Adapters normalize provider payloads into a
common envelope and POST it to the agent's configured callback URL.

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
`slack` (Events API, signing-secret verification), `github` (HMAC
verification). The `conversationKey` formats and the session-bound tool
pattern follow the service contracts (§C4). An event without
`id`/`eventId`/`deliveryId` gets a random fallback key so events never
collapse into one conversation (P13).

### 4. Coordination (Phase 2)

A standalone MCP + SSE service that gives agents presence, messaging,
and a task board, scoped by project and branch. Full design:
[cross-machine collaboration spec](2026-08-28-cross-machine-collaboration-design.md).

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
│   └── templates/AGENTS.base.md # Shared agent base template
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

No vendor-specific services. Users add upstreams via `config.json` and
extend via `docker-compose.override.yml`.

---

## Success Criteria

1. `docker compose up` starts a working stack with zero configuration
   beyond an empty `config.json`. The extractor runs on CPU with no
   model pre-download step.
2. A user adds an upstream MCP server to `config.json`, restarts the
   hub, and the new tools appear in `list_available_mcps`.
3. A `POST /memory/proposals` with a fact reaches Chroma after the
   extraction pipeline runs — with the extractor pointed at the bundled
   llama.cpp container, and again when pointed at a remote
   OpenAI-compatible endpoint, with no code change.
4. A webhook event hits the ingress service and arrives at the user's
   agent callback URL as a `ChannelEvent`.
5. `provisioning/bin/sync-agents` writes one rendered template to every
   harness target, and `install-skills` installs the curated list on a
   clean machine (see provisioning spec).
6. (Phase 2) The scenarios in the collaboration spec's success criteria
   pass: same-project/same-branch agents collaborate, other-branch
   agents are discoverable only, and expired claim leases return tasks
   to the board.

---

## Open Questions

- Does the Chroma JS client require a scope fan-out workaround for
  array-valued metadata (`scope_id_0..5`, `$or` caps — P16)? Verify
  during implementation.
- Which embedding function does the memory worker use with the Chroma JS
  client (Chroma default vs. the extractor endpoint's embeddings API)?

## Parking Lot — Ideas to Discuss

> Captured but not yet designed.

- [ ] _Your ideas go here — tell me what else you have in mind._
