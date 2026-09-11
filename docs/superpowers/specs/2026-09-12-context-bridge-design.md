# Context Bridge Design

**Status:** Approved architecture

> **Parent:** [Unified Context Engine Design](2026-09-11-unified-context-engine-design.md)
> **Related:** [Phase 2 Memory Roadmap](2026-09-11-phase-2-memory-roadmap.md)

## Purpose

The Context Bridge lets a user continue work in a new chat on the same
workstation without explaining the project again. It transfers a small,
explicitly approved context packet between local agent processes. It does not
transfer a transcript, create durable memory, or make context available to
unrelated chats automatically.

The first release is intentionally local-only:

- same operating-system user;
- same workstation;
- same repository identity by default, with an explicit workstation-wide mode;
- no network request;
- no shared-memory record;
- no cross-user or team sharing.

Cross-user sharing is a later authorization feature and is outside this design.

## Goals

1. Export a bounded context packet from one chat through an explicit user
   action.
2. Import that packet explicitly in another chat on the same workstation.
3. Preserve goals, decisions, open questions, selected evidence handles, and
   project identity without retaining the source conversation.
4. Make packets expire, revoke, and clean up automatically.
5. Keep all packet data local and protected by the workstation user boundary.
6. Reuse the context engine's evidence and freshness contracts.
7. Make imported context visible as imported context, not current authoritative
   memory.

## Non-goals

- Automatic context transfer between arbitrary chats.
- Raw transcript, prompt, hidden reasoning, or session-log storage.
- A second memory database or a replacement for `.agents/memory.md`.
- Cross-user, cross-workstation, team, or organization sharing.
- Automatic task-state, diary, handoff, or workflow persistence.
- Automatic source-code or diff capture.
- Carrying a context cursor across processes. Cursors remain process-local;
  imported work starts with a new cursor.

## Relationship to existing memory rules

The bridge is an explicit, short-lived context export. It is not a durable
memory entry and is not a transcript or handoff store. The existing rules stay
unchanged:

- durable local facts require `brain_memory_propose` and `brain_memory_save`;
- shared facts use `propose_memory`, `remember`, and `forget`;
- retrieval never writes durable memory;
- no raw chat is accepted or persisted;
- secrets and absolute workstation paths are rejected.

The bridge packet may contain repository-relative evidence references and
commit identifiers, but it does not contain source excerpts, diffs, or private
credentials.

## Wake versus Context Bridge

These features solve different problems and must remain separate in both the
MCP surface and the receiving chat's instructions:

| Feature | When it runs | What it contains | Where it comes from | Persistence |
|---|---|---|---|---|
| Wake | Automatically when a new chat starts in a project | A tiny project orientation: identity, current work area, and a few provider-health facts | Provider-derived state and bounded retrieval | No bridge packet; it is regenerated for the chat |
| Context Bridge | Only after the user explicitly exports and imports a handle | A bounded, chat-specific goal, decisions, questions, and evidence references | The exporting chat's explicit packet fields | Local expiring vault; never durable memory |

Wake is safe orientation, not a continuation of another conversation. It must
not discover bridge packets, infer a handle, or silently import chat-specific
decisions. Context Bridge is an explicit continuation mechanism, not a larger
wake payload: it must not run automatically, search the vault, or replace the
normal memory-promotion flow. An imported packet is labeled as imported
context, and the receiving chat may promote a fact only through the existing
explicit local/shared-memory operations.

## Architecture

```text
Chat A
  │ explicit brain_context_export
  ▼
Local Context Bridge
  ├── validate and scan packet
  ├── write mode-0600 packet with expiry
  └── return opaque handle
       │
       │ explicit brain_context_import(handle)
       ▼
Chat B
  └── receives packet as imported, bounded context
```

The bridge lives beside the local context engine. It never calls the shared
memory worker and never sends packet data over the network.

The local vault is outside the repository, under the user's Wagglebot state
directory:

```text
~/.wagglebot/context/
└── <hash-of-handle>.json
```

The directory is created with mode `0700`; packet files use mode `0600`.
The stored filename is derived from a hash of the opaque handle, so the handle
itself is not present in the directory listing. The vault is a bounded,
expiring packet cache, not a transcript database. Startup and every operation
remove expired packets and enforce the configured count/size limits.

## Packet contract

The packet is strict JSON internally and is returned as compact structured data
plus a short human-readable preview. A v1 packet contains:

```typescript
type ContextBridgePacket = {
  schemaVersion: 1;
  packetId: string;
  project: {
    rootKey: string;
    component?: string;
    system?: string;
    branch?: string;
    head?: string;
  };
  scope: "project" | "workstation";
  goal: string;
  decisions: Array<{ title: string; summary: string }>;
  openQuestions: string[];
  evidence: EvidenceRef[];
  providerState: {
    localBrain: "ready" | "degraded" | "missing";
    sharedMemory: "ready" | "degraded" | "not_requested";
  };
  createdAt: string;
  expiresAt: string;
};
```

The caller supplies finished fields. The service does not receive a
conversation transcript, prompt, model reasoning, or arbitrary session object.
An agent may distill the active chat into these fields, but exporting requires
an explicit user action.

Limits:

- goal: 300 Unicode code points;
- each decision title: 80 code points;
- each decision summary: 600 code points;
- at most 10 decisions;
- at most 10 open questions, 240 code points each;
- at most 20 evidence references;
- serialized packet: 16 KiB;
- default lifetime: one hour;
- maximum lifetime: four hours.

The bridge runs the shared secret scanner over the serialized packet before it
is written. It rejects secrets, NUL/control characters, absolute paths,
transcript-shaped fields, and unknown schema fields. It does not log packet
content, goals, questions, evidence, handles, or local paths.

## Project binding and local authorization

Export resolves the canonical Git root and computes a non-reversible
`rootKey`. The default `project` scope binds the packet to that root. Import
requires the current project to have the same `rootKey`.

The caller may explicitly select `workstation` scope when exporting. The
service shows that this permits import into another local repository for the
same operating-system user. The packet still records its originating project,
but import does not require a matching `rootKey`. There is no implicit upgrade
from project scope to workstation scope and no import-time override.

The vault accepts packets only for the current operating-system user. On
platforms that expose a numeric user id, the vault verifies file ownership as
well as mode. A mode or ownership failure is treated as unavailable, not as a
reason to weaken permissions.

The opaque handle is generated with cryptographically secure randomness. It is
required for import and revoke. Status may report bounded packet metadata for
the current project/user, but never returns handles or packet prose, so it
cannot become a handle-discovery shortcut. Possession of a handle is not enough
to cross the operating-system user boundary because the packet file is
mode-0600 and the vault directory is mode-0700.

## Lifecycle

1. `brain_context_export` validates the project and structured fields.
2. The bridge scans and canonicalizes the packet.
3. It writes a temporary mode-0600 file, flushes it, and atomically renames it
   into the vault.
4. It returns the handle, expiry, project identity, and a compact preview.
5. `brain_context_import` validates the handle, scope binding, ownership,
   expiry, and packet schema, then returns the packet.
6. Import increments a bounded access counter. A packet may be imported up to
   eight times before it must be exported again.
7. `brain_context_revoke` deletes the packet atomically and is idempotent.
8. Expired packets are removed during every operation and during service
   startup.

An import does not modify local memory, shared memory, CodeGraph, Git state, or
task state. The receiving chat decides whether to use the packet and must make
any later memory promotion explicit.

## MCP operations

The unified context-engine MCP service adds four local tools:

- `brain_context_export` — accepts only the packet fields, explicit scope, and
  optional lifetime;
- `brain_context_import` — accepts an opaque handle and project path;
- `brain_context_status` — reports packet count, expiry, and scope/project
  binding, never handles or packet prose;
- `brain_context_revoke` — removes one packet by handle.

The tools require an absolute `projectPath`, return repository-relative
metadata, and use stable errors such as `context_invalid`, `context_expired`,
`context_project_mismatch`, `context_owner_mismatch`, `context_limit`, and
`context_unavailable`.

The packet prose appears once in the structured result and once in the
human-readable preview only when the caller explicitly requests Markdown
preview. The default structured response follows the unified engine's
single-representation rule.

## Failure behavior

| Failure | Behavior |
|---|---|
| Missing vault | Create it with strict permissions on first export; import reports unavailable when no packet exists. |
| Invalid packet fields | Reject before writing; no partial file remains. |
| Secret-like content | Reject with scanner rule/count only; never echo content. |
| Expired handle | Return `context_expired` and remove the packet. |
| Wrong project | Return `context_project_mismatch` for project-scoped packets; do not reveal packet contents. |
| Wrong owner or unsafe permissions | Return `context_owner_mismatch` or `context_unavailable`. |
| Concurrent export | Use unique handles and atomic rename; both exports remain independent. |
| Vault full | Remove expired packets first, then return `context_limit` without eviction of live packets. |
| Corrupt packet | Remove only the corrupt packet and return `context_unavailable`. |

## Testing

Tests must cover:

1. strict packet validation and every size limit;
2. secret, transcript-field, absolute-path, NUL, and unknown-field rejection;
3. mode-0700 directory and mode-0600 packet creation;
4. atomic export and cleanup after write failure;
5. same-project import success;
6. project mismatch, expiry, revocation, corrupt packet, and ownership failure;
7. eight-import cap and live-packet vault limits;
8. no network calls, no shared-worker calls, and no packet-content logging;
9. restart persistence within the expiry window;
10. MCP schemas exposing no transcript, prompt, session-file, or free-form
    replacement field;
11. imported packets remaining non-durable until a separate explicit memory
    promotion operation.

## Acceptance criteria

- A user can export a bounded context packet from one local chat and import it
  in another chat for the same repository.
- A new chat cannot access the packet without the explicit handle.
- A project-scoped packet cannot be imported by a different repository.
- A workstation-scoped packet can cross repositories only when that scope was
  explicitly selected during export.
- The packet survives a local service restart only until its expiry.
- No raw transcript, hidden reasoning, source excerpt, credential, or absolute
  path is stored or returned.
- Revocation and expiry prevent further imports.
- The feature makes no network or shared-memory request.
- Existing local-memory, shared-memory, cursor, and MCP representation rules
  remain unchanged.

## Placement and rollout

Implement after the Unified Context Engine milestone. The bridge reuses its
contracts, evidence references, project identity, and local MCP service, but
does not depend on the shared memory worker.

The first release is local-only. A later cross-user version would require a
separate authorization design, explicit grants, recipient identity, audit
events, and revocation semantics; it must not be added by widening this local
packet's scope.
