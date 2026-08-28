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

## Workspace Identity and Scoping

Each agent registers with a **workspace identity**:

```
{ agentId, name, owner,            // owner = the human engineer
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
| **Task board** | FIFO + optional integer priority (order `priority DESC, created_at ASC`). Each claim carries a lease with a heartbeat. A task returns to the board when its claimer stops (for example, a laptop sleeps) (D5). The task shape uses `JobSpec`/`JobResult` from the [service contracts §C5](2026-08-28-service-contracts.md#c5-delegated-job-vocabulary). Each task is scoped to a `projectKey`, and optionally a branch. |
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
its own engineer. The claim lease prevents two agents from answering one
Slack mention.

## Networking

- LAN pairing: one machine runs the shared stack. The other machine
  points `MCP_HUB_URL` (and through it, coordination) at the IP of the
  first machine.
- Remote pairing: Tailscale, WireGuard, or an ngrok tunnel.
- Each component is a Docker container with documented env vars. There
  is no platform-specific deployment tooling (see the non-goals of the
  main spec).

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
