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

## Identity and Authorization

Every request to the coordination service carries a **principal**. A
principal is one human engineer, named by the company username (for
example, the SSO name).

The shared layer holds one file, `principals.json`:

```
{ username → { tokenHash, teams[] } }
{ team     → { projectPatterns[] } }
```

Rules:

1. The administrator issues one coordination token per engineer. The
   token binds to one username. The service derives the principal from
   the token, never from a request field.
2. The service derives the allowed projects from the teams of the
   principal. It rejects a `projectKey` outside that set.
3. An agent registers under its principal. A second registration with
   the same `agentId` and a different principal is rejected.
4. Administrator actions (principal changes, token rotation) use a
   separate administrator token. Agent tokens cannot perform them.
5. Every cross-project operation has a denial test.

The memory worker applies the same principal model to memory scopes.

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

Approval applies to **direct connections between people**. Project and
branch channels need no approval: agents on the same project already
share that scope.

## Workspace Identity and Scoping

Each agent registers with a **workspace identity**:

```
{ agentId, name, owner,            // owner = the username of the engineer
  machine, capabilities[],
  workspace: { projectKey, branch },
  heartbeatAt }
```

- `projectKey` = the normalized git remote URL of the repo of the agent.
  Normalization: strip the scheme, the credentials, and `.git`, then
  lowercase. Example: `github.com/swiknaba/agentframe`.
- `branch` = the current git branch. Each heartbeat refreshes the
  branch. The agent therefore follows its human across checkouts.

Scoping rules:

| Relationship | What is allowed |
|---|---|
| Same `projectKey` + same `branch` | Full collaboration: messages, task handoff, shared memory scope |
| Same `projectKey`, different branch | Discovery + messages (example: "I change the same file on branch X") |
| Different `projectKey` | Invisible to each other by default |

Enablement is **opt-in per engineer**. An agent joins coordination only
when its operator sets `COORD_URL` + `COORD_BEARER_TOKEN`. Each message
carries the owner identity. Engineers can read each channel log they
have access to (`GET /channels/:key/log`). The humans stay in the loop.

## Components

| Component | Design |
|---|---|
| **Presence registry** | Agents register with a workspace identity and a heartbeat. `list_agents` defaults to the `projectKey` of the caller. Filters exist for project and branch. Stale entries expire on missed heartbeats. |
| **Message bus** | Channels are keyed `project/<key>` and `project/<key>/branch/<branch>`. Direct agent-to-agent messages are allowed within a project. The log is persistent and append-only. Delivery is SSE with `Last-Event-ID` replay, a 7-day TTL, and a SQLite store (D6). |
| **Task board** | FIFO + optional integer priority (order `priority DESC, created_at ASC`). Each claim carries a lease with a heartbeat **and a monotonic fencing token**. A task returns to the board when the lease expires (D5). Completion and heartbeats must present the current fencing token. A stale token is rejected. Delivery is therefore **at-least-once**, and every external effect carries an idempotency key. The task shape uses the envelope from the [service contracts §C5](2026-08-28-service-contracts.md#c5-delegated-job-vocabulary). Each task is scoped to a `projectKey`, and optionally a branch. |
| **Shared memory** | All participating agents point at the same memory-worker + Chroma. `scopeIds` carry the `projectKey`. Shared memory is therefore project-scoped by construction. |

**Exposure:** the coordination service is itself an MCP server. Each
local hub registers it via `registry.json` (D4). Agents gain these
`coordination_*` tools: `list_agents`, `send_message`, `read_channel`,
`post_task`, `claim_task`, `complete_task`.

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
