# Cross-Machine Agent Collaboration (Phase 2)

> Companion to the [agentframe design spec](2026-08-28-agentframe-design.md).
> Decisions D4–D6 apply: standalone container, FIFO + priority task
> board with claim leases, persistent messages with SSE replay.

## Use Cases

- Two engineers work on the same project. Each oversees a local agent.
  They enable collaboration, and their agents exchange findings and hand
  off tasks — scoped to that project and branch.
- A research agent on one machine feeds findings to a coding agent on
  another.
- Shared durable memory across the team without a central cloud deploy.

## Workspace Identity and Scoping

Every agent registers with a **workspace identity**:

```
{ agentId, name, owner,            // owner = the human engineer
  machine, capabilities[],
  workspace: { projectKey, branch },
  heartbeatAt }
```

- `projectKey` = the normalized git remote URL of the repo the agent
  works in: strip scheme, credentials, and `.git`; lowercase. Example:
  `github.com/swiknaba/agentframe`.
- `branch` = the current git branch, refreshed on every heartbeat so the
  agent follows its human across checkouts.

Scoping rules:

| Relationship | What is allowed |
|---|---|
| Same `projectKey` + same `branch` | Full collaboration: messages, task handoff, shared memory scope |
| Same `projectKey`, different branch | Discovery + messages (useful for "heads up, I am touching the same file on branch X") |
| Different `projectKey` | Invisible to each other by default |

Enablement is **opt-in per engineer**: an agent joins coordination only
when its operator sets `COORD_URL` + `COORD_BEARER_TOKEN`. Every message
carries the owner identity, and engineers can read any channel log they
have access to (`GET /channels/:key/log`) — the humans stay in the loop.

## Components

| Component | Design |
|---|---|
| **Presence registry** | Register with workspace identity + heartbeat. `list_agents` defaults to the caller's own `projectKey`; filters for project/branch. Stale entries expire on missed heartbeats. |
| **Message bus** | Channels keyed `project/<key>` and `project/<key>/branch/<branch>`, plus direct agent-to-agent within a project. Persistent append-only log, SSE delivery with `Last-Event-ID` replay, 7-day TTL, SQLite (D6). |
| **Task board** | FIFO + optional integer priority (order `priority DESC, created_at ASC`); claim leases with heartbeat so tasks return to the board when a laptop sleeps (D5). Task shape uses `JobSpec`/`JobResult` from the [service contracts §C5](2026-08-28-service-contracts.md#c5-delegated-job-vocabulary). Tasks are scoped to a `projectKey` (optionally a branch). |
| **Shared memory** | All participating agents point at the same memory-worker + Chroma. `scopeIds` carry the `projectKey`, so shared memory is project-scoped by construction. |

**Exposure:** the coordination service is itself an MCP server,
registered in the hub via `config.json` (D4). Agents gain
`coordination_*` tools: `list_agents`, `send_message`, `read_channel`,
`post_task`, `claim_task`, `complete_task`.

## Networking

- LAN pairing: one machine runs the shared stack; the other points
  `MCP_HUB_URL` (and through it, coordination) at the first machine's
  IP.
- Remote pairing: Tailscale, WireGuard, or an ngrok tunnel.
- Everything is a Docker container with documented env vars — no
  platform-specific deployment tooling (see the main spec's non-goals).

## Success Criteria

1. Two agents on different machines, registered with the same
   `projectKey` and branch, see each other in `list_agents` and exchange
   messages.
2. An agent on a different branch of the same project is discoverable
   and messageable, but excluded from the branch channel.
3. An agent from a different project sees nothing.
4. An agent disconnects mid-claim; its task returns to the board after
   the lease expires.
5. An agent reconnects after sleep and replays missed channel messages
   from its cursor.
6. A branch checkout on the engineer's machine moves the agent to the
   new branch channel on the next heartbeat.
