# Cross-Machine Agent Collaboration (Phase 2)

> Companion to the [agentframe design spec](2026-08-28-agentframe-design.md).
> Decisions D4–D6 apply: a standalone container, a FIFO + priority task
> board with claim leases, and persistent messages with SSE replay.

## Use Cases

- Two engineers work on the same project. Each engineer oversees a local
  agent. They enable collaboration. Their agents then exchange findings
  and hand off tasks, scoped to that project and branch.
- A research agent on one machine feeds findings to a coding agent on a
  different machine.
- The team shares durable memory without a central cloud deploy.

## The Trust Model: Trusted Coworkers

Every registered engineer is a trusted coworker. Agentframe therefore
uses identity for **routing, context, and attribution**, never as a
source-code access boundary. Git and the identity provider of the
company already control code access.

| Agentframe does | Agentframe does not |
|---|---|
| Name who acts, for attribution | Decide who may read a repository |
| Route tasks and events to the right team | Grant or deny tool access by team |
| Select the effective registry | Block collaboration between teams |
| Scope memory search for relevance | Treat a memory scope as a security boundary |

Two authenticated roles exist, and only two:

| Role | Token | May |
|---|---|---|
| Engineer | One user token, all shared services | Register agents, use channels and the task board, propose memory, publish for the own team |
| Operator | One operator token | Edit the central files, rotate a token, call the direct memory endpoints |

## Central Files

Engineering managers maintain three small files in one central
repository. Repository write access is the only permission system.

```json
// users.json
{ "users": [
  { "username": "alice", "tokenHash": "...", "teams": ["payments"] }
] }

// teams.json
{ "teams": [
  { "team": "payments", "manager": "bob", "projects": ["payments-platform"] }
] }

// channels.json  — see the routing section
```

Rules:

1. The operator issues one **user token** per engineer. The token binds
   to one `username`. Each shared service derives the identity from the
   token, never from a request field. This prevents impersonation and
   gives correct attribution.
2. `username` is the company Git username, in lowercase.
3. A service reads teams from `users.json`. Team values select defaults
   and routes. They never deny an operation between registered users.
4. An agent registers under its user. A second registration with the
   same `agentId` and a different user is rejected.
5. Operator actions need the operator token.
6. One validation command checks all central files, prints the
   effective configuration, and reports conflicts.

NOTE: An earlier review asked for project-level authorization. That
request assumed an untrusted multi-tenant deployment. This deployment is
one company of trusted coworkers, so the authorization model is
deliberately absent. Only impersonation protection and operator actions
remain restricted.

## Teams, Projects, And Agents Are Separate Identifiers

Agentframe assumes no repository layout. One team runs a
monorepository. Another team spreads one project across many service
repositories. A third team owns several projects. Therefore the design
declares projects, and never derives them from a Git remote.

| Identifier | Source | Purpose |
|---|---|---|
| `team` | `teams.json` | Routing, registry selection, ownership |
| `projectKey` | The nearest `.agentframe/project.json`, else the normalized Git remote | Working context, memory relevance |
| `username` | `users.json` | Attribution, direct messages |
| `agentId` | Generated per agent process | Presence, claims |

`teams.json` lists the projects that each team owns.
`.agentframe/project.json` maps a subtree to one of those projects, and
the nearest declaration wins. A team therefore selects its own
granularity, and the declaration survives a rename or a move. A branch
is context, never identity.

## Connecting To A Person

An engineer connects to a colleague by **username, never by address**.
IP addresses, VPNs, and tunnels do not appear in this design. All
traffic flows through the shared coordination service.

The connection flow:

1. Agent A requests a connection: `connect_to("username-b")`.
2. The service delivers the request to the agents of engineer B.
3. **Engineer B sees who asks** — the username, the agent name, the
   machine, and the project — **and approves or rejects.**
4. An approval persists. Later messages between the two flow without a
   new approval, until either engineer revokes the grant.

Approval is a **user preference**, not an access rule. It stops an agent
from interrupting a colleague without consent. A rejection carries no
security meaning, and it never blocks the shared channels.

## Workspace Identity and Scoping

Each agent registers with a **workspace identity**:

```
{ agentId, name, owner,            // owner = the username of the engineer
  machine, capabilities[],
  workspace: { projectKey, branch },
  heartbeatAt }
```

- `projectKey` = the project declared by the nearest
  `.agentframe/project.json`, walking up from the working directory.
  Repositories that declare the same value share one project. The
  normalized Git remote is the fallback when no file exists (D20).
- `branch` = the current git branch. Each heartbeat refreshes the
  branch. The agent therefore follows its human across checkouts.

Scoping selects **defaults**, never permissions. Every registered
engineer can discover coworkers, send messages, and hand off tasks
across every team. Teams whose software shares interfaces must
collaborate, so the design never blocks that path.

| Relationship | Default behavior |
|---|---|
| Same `projectKey` + same `branch` | The branch channel joins automatically |
| Same `projectKey`, different branch | The project channel joins automatically |
| Same team, other project | Discoverable. The team channel joins automatically. |
| Other team | Discoverable and reachable. No channel joins automatically. |

Enablement is **opt-in per engineer**. An agent joins coordination only
when its operator sets `COORD_URL` and the user token. Each message
carries the user identity. The humans stay in the loop.

## Components

| Component | Design |
|---|---|
| **Presence registry** | Agents register with a workspace identity and a heartbeat. `list_agents` defaults to the `projectKey` of the caller. Filters exist for project and branch. Stale entries expire on missed heartbeats. |
| **Message bus** | Channels are keyed `project/<key>` and `project/<key>/branch/<branch>`. Direct agent-to-agent messages are allowed within a project. The log is persistent and append-only. Delivery is SSE with `Last-Event-ID` replay, a 7-day TTL, and a SQLite store (D6). |
| **Task board** | FIFO + optional integer priority (order `priority DESC, created_at ASC`). Each claim carries a lease with a heartbeat **and a monotonic fencing token**. A task returns to the board when the lease expires (D5). Completion and heartbeats must present the current fencing token. A stale token is rejected. Delivery is therefore **at-least-once**, and every external effect carries an idempotency key. The task shape uses the envelope from the [service contracts §C5](2026-08-28-service-contracts.md#c5-delegated-job-vocabulary). Each task is scoped to a `projectKey`, and optionally a branch. |
| **Shared memory** | All participating agents point at the same memory-worker + Chroma. `scopeIds` carry the `projectKey`, so every repository that declares the same project shares one memory pool (D20). |

**Exposure:** the coordination service is itself an MCP server. Each
local hub registers it via `registry.json` (D4). Agents gain these
`coordination_*` tools: `list_agents`, `send_message`, `read_channel`,
`post_task`, `claim_task`, `complete_task`.

## Channel Routing

An incoming event must reach the owning team. The shared layer therefore
holds `channels.json`, which maps each ingress source to a route:

```json
{ "routes": [
  { "source": "slack",  "match": { "channelId": "C123" },
    "team": "payments", "projectKey": "github.com/acme/pay-api",
    "responder": "shared", "allowedEvents": ["slack.app_mention"],
    "replyIdentity": "payments-bot" },
  { "source": "github", "match": { "repo": "acme/pay-api" },
    "team": "payments", "projectKey": "github.com/acme/pay-api",
    "responder": "shared", "allowedEvents": ["github.issue_comment.created"] }
] }
```

Rules:

1. Ingress resolves the route before it creates a task. The route
   supplies the team, the project, the responder, and the reply
   identity.
2. Ingress **rejects an event with no route, or with more than one
   route**. It logs the rejection. It never guesses a team from message
   text.
3. An event type outside `allowedEvents` is dropped, and logged.
4. The validation command reports every unrouted channel and every
   duplicate match.

## Task Eligibility

The task envelope carries eligibility. The board supports these forms:

| Eligibility | Claimable by |
|---|---|
| `shared_responder` | The shared responder agent |
| `owner:<username>` | Agents of that engineer |
| `team:<team>` | Agents of any member of that team |
| `project:<projectKey>` | Agents working in that project |
| `any` | Any registered agent |

An eligibility entry may also require a capability set. Within the
eligible set, ordering stays FIFO with priority
(`priority DESC, created_at ASC`). When several eligible agents wait,
the first claim wins. The board never assigns work.

## The Task Board Also Serves Ingress

The ingress service posts each `ChannelEvent` to this task board (D11).
A channel event and a delegated job therefore share one queue and one
claim mechanism.

| Task source | Scope | Default claimer |
|---|---|---|
| Ingress channel event | The project of the channel | The shared responder agent |
| Agent-to-agent handoff | `projectKey` and branch | Any eligible local agent |

The shared responder agent claims team-facing events, because it stays
on and holds the bot tokens. A local agent may claim events routed to
its own engineer.

A lease alone cannot give exactly-once replies. A responder can finish a
reply after its lease expires, and a second responder can then claim the
task. The fencing token and the idempotency key close that gap: the
board rejects a completion with a stale token, and the channel action
deduplicates on its key.

## Networking

The company already runs the shared layer on its internal network. That
service is the only rendezvous point.

- Every agent connects **outbound** to the coordination service. No
  agent accepts an inbound connection.
- No agent needs the address of another agent. Usernames replace
  addresses.
- No VPN, tunnel, or LAN pairing is part of this design.
- A solo engineer without a shared layer starts the `shared` compose
  profile locally.

## Success Criteria

1. Two agents on different machines register with the same `projectKey`
   and branch. They see each other in `list_agents` and exchange
   messages.
2. An agent on a different branch of the same project is discoverable
   and messageable. The branch channel excludes it.
3. An agent from a different project sees nothing.
4. An agent disconnects with a claimed task. The task returns to the
   board after the lease expires.
5. An agent reconnects after sleep. It replays missed channel messages
   from its cursor.
6. The engineer checks out a different branch. The next heartbeat moves
   the agent to the new branch channel.
7. Engineer A requests a connection to engineer B by username. B sees
   the requester identity and approves. Messages then flow. B revokes
   the grant, and messages stop.
8. A token bound to engineer A cannot register an agent as engineer B.
   It also cannot read a project outside the teams of A.
9. A responder completes a task after its lease expired. The board
   rejects the completion. The retry deduplicates on the idempotency
   key, and the channel receives one reply.
