# Cross-Machine Agent Collaboration (Phase 2)

> Companion to the [wagglebot design spec](2026-08-28-wagglebot-design.md).
> Decisions D4–D6 apply: a standalone container, a FIFO + priority task
> board with claim leases, and persistent messages with SSE replay.

## Use Cases

- Two engineers work on the same system. Each engineer oversees a local
  agent. They enable collaboration. Their agents then exchange findings
  and hand off tasks, scoped to that system and branch.
- A research agent on one machine feeds findings to a coding agent on a
  different machine.
- The team shares durable memory without a central cloud deploy.

## The Trust Model: Trusted Coworkers

Every registered engineer is a trusted coworker. Wagglebot therefore
uses identity for **routing, context, and attribution**, never as a
source-code access boundary. Git and the identity provider of the
company already control code access.

| Wagglebot does | Wagglebot does not |
|---|---|
| Name who acts, for attribution | Decide who may read a repository |
| Route tasks to the right team | Grant or deny tool access by team |
| Select the effective registry | Block collaboration between teams |
| Scope memory search for relevance | Treat a memory scope as a security boundary |

Two authenticated roles exist, and only two:

| Role | Token | May |
|---|---|---|
| Engineer | An SSH key signature, exchanged for a session token | Register agents, use channels and the task board, propose memory, publish for the own team |
| Operator | Write access to the central repository | Edit the central files, remove a user, call the direct memory endpoints |

## Central Files

Engineering managers maintain two small files in one central
repository. Repository write access is the only permission system.

**There is no user token, and no `users.yaml` (D26).** An engineer
authenticates with the SSH key they already have:

1. The agent asks the shared layer for a nonce.
2. The agent signs the nonce through `ssh-agent`.
3. The shared layer verifies the signature against the registered
   public key, and returns a short-lived session token.

The default key source is the catalog, so the key travels by pull
request:

```yaml
# catalog.yaml
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice                # company Git username, lowercase
  annotations:
    wagglebot.dev/ssh-key: "ssh-ed25519 AAAAC3Nza..."
    wagglebot.dev/org-owner: "true"    # optional, D23
spec:
  memberOf: [team-payments]
```

A public key is public, so the repository holds no secret. This source
works with every Git host, including Bitbucket Server. A deployment on
GitHub or GitLab may instead set the `github` source, which fetches
`<host>/<username>.keys` and caches the result.

`catalog.yaml` holds the Backstage entities: Domain, System, Group, and
User. Group membership lives only there (`Group.spec.members`). The
org-owner annotation grants publication to the `org` memory scope
(D23). The
[service contracts](2026-08-28-service-contracts.md) give both schemas.

Each repository declares its components in `catalog-info.yaml`, or in
`.wagglebot/catalog.yaml` with the identical schema.

Rules:

1. An engineer proves identity with an **SSH key signature**, and
   receives a short-lived session token (D26). Each shared service
   derives the identity from that token, never from a request field.
   This prevents impersonation and gives correct attribution. No
   operator delivers a credential, and no credential needs rotation.
2. `username` is the company Git username, in lowercase. It is the
   `metadata.name` of the User entity.
3. A service reads the identity, the public key, the group membership,
   and the hierarchy from `catalog.yaml`. Group values select defaults
   and routes. They never deny an operation between registered users.
   The one exception: publication into the `domain` and `org` memory
   scopes is gated by the catalog (D23).
4. An agent registers under its user. A second registration with the
   same `agentId` and a different user is rejected.
5. Operator actions need write access to the central repository.
6. One validation command checks all central files, prints the
   effective configuration, and **rejects every duplicate** (D27). Two
   entities of one kind sharing a name, and a component naming an
   unknown system, are hard errors. The message names the file and the
   value.

NOTE: An earlier review asked for project-level authorization. That
request assumed an untrusted multi-tenant deployment. This deployment is
one company of trusted coworkers, so the authorization model is
deliberately absent. Only impersonation protection and operator actions
remain restricted.

## Identifiers Follow The Backstage Entity Model

Wagglebot assumes no repository layout, and derives nothing from a Git
remote. The catalog declares everything (D20).

| Identifier | Source | Purpose |
|---|---|---|
| `domain` | `catalog.yaml` | Broad grouping, wide memory read scope |
| `system` | `catalog.yaml` | The project. Promoted memory scope, channel key. |
| `component` | The repository declaration | The unit of work. Local memory file, attribution. |
| `group` | `catalog.yaml`, `parent` for subteams | Routing, registry selection, ownership |
| `username` | `catalog.yaml`, the User entity | Attribution, direct messages |
| `agentId` | Generated per agent process | Presence, claims |

Ownership is separate from grouping: every entity names an owning group.
A reorganization therefore edits one `owner` field, and never renames a
system or a domain.

A team selects its own granularity by where it places the component
declaration. The declaration survives a rename or a move. A branch is
context, never identity.

## Connecting To A Person

An engineer connects to a colleague by **username, never by address**.
IP addresses, VPNs, and tunnels do not appear in this design. All
traffic flows through the shared coordination service.

The connection flow:

1. Agent A requests a connection: `connect_to("username-b")`.
2. The service delivers the request to the agents of engineer B.
3. **Engineer B sees who asks** — the username, the agent name, the
   machine, and the system — **and approves or rejects.**
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
  workspace: { system, component, branch },
  heartbeatAt }
```

- `system` and `component` come from the closest enclosing declaration.
  Components that name the same system share one memory space and one
  channel. An undeclared repository has no system, and wagglebot never
  infers one (D20).
- `branch` = the current git branch. Each heartbeat refreshes the
  branch. The agent therefore follows its human across checkouts.

Scoping selects **defaults**, never permissions. Every registered
engineer can discover coworkers, send messages, and hand off tasks
across every team. Teams whose software shares interfaces must
collaborate, so the design never blocks that path.

| Relationship | Default behavior |
|---|---|
| Same `system` + same `branch` | The branch channel joins automatically |
| Same `system`, different branch | The system channel joins automatically |
| Same domain, other system | Discoverable. The domain channel joins automatically. |
| Other domain | Discoverable and reachable. No channel joins automatically. |

Enablement is **opt-in per engineer**. An agent joins coordination only
when its operator sets `COORD_URL` and signs in with the SSH key. Each message
carries the user identity. The humans stay in the loop.

## Components

| Component | Design |
|---|---|
| **Presence registry** | Agents register with a workspace identity and a heartbeat. `list_agents` defaults to the `system` of the caller. Filters exist for domain, system, and branch. Stale entries expire on missed heartbeats. |
| **Message bus** | Channels are keyed `system/<name>`, `system/<name>/branch/<branch>`, and `domain/<name>`. Direct agent-to-agent messages need no channel. The log is persistent and append-only. Delivery is SSE with `Last-Event-ID` replay, a 7-day TTL, and a SQLite store (D6). |
| **Task board** | FIFO + optional integer priority (order `priority DESC, created_at ASC`). Each claim carries a lease with a heartbeat **and a monotonic fencing token**. A task returns to the board when the lease expires (D5). Completion and heartbeats must present the current fencing token. A stale token is rejected. Delivery is therefore **at-least-once**, and every external effect carries an idempotency key. The task shape uses the envelope from the [service contracts §C4](2026-08-28-service-contracts.md#c4-task-envelope-and-delegated-job-vocabulary-phase-2). Each task is scoped to a `system`, and optionally a branch. |
| **Shared memory** | All participating agents point at the same memory-worker + Chroma. `scopeIds` carry the `component` and the `system` of the workspace. Agent writes default to `component`, with confirmed promotion to `system` (D22). |

**Exposure:** the coordination service is itself an MCP server. Each
local hub registers it via `registry.yaml` (D4). Agents gain these
`coordination_*` tools: `list_agents`, `send_message`, `read_channel`,
`post_task`, `claim_task`, `complete_task`.

## Task Eligibility

The task envelope carries eligibility. The board supports these forms:

| Eligibility | Claimable by |
|---|---|
| `owner:<username>` | Agents of that engineer |
| `group:<group>` | Agents of any member of that group |
| `system:<name>` | Agents working in that system |
| `any` | Any registered agent |

An eligibility entry may also require a capability set. Within the
eligible set, ordering stays FIFO with priority
(`priority DESC, created_at ASC`). When several eligible agents wait,
the first claim wins. The board never assigns work.

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

1. Two agents on different machines register with the same `system` and
   branch. They see each other in `list_agents` and exchange messages.
2. An agent on a different branch of the same system is discoverable and
   messageable. The branch channel excludes it.
3. An agent in another domain is discoverable, and joins no channel automatically.
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
   It also cannot publish to a domain whose owner group excludes A, and
   it cannot publish to `org` without the org-owner flag (D23).
9. An agent completes a task after its lease expired. The board
   rejects the completion. The retry deduplicates on the idempotency
   key, and the channel receives one reply.
