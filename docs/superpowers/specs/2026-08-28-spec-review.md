# Agentframe Specification Review

**Review date:** 2026-08-28  
**Review scope:** All four specifications and the repository README.  
**Assessment:** The architecture is coherent, but the specifications are not ready for implementation.

## Reviewed Documents

- `2026-08-28-agentframe-design.md`
- `2026-08-28-service-contracts.md`
- `2026-08-28-cross-machine-collaboration-design.md`
- `2026-08-28-provisioning-design.md`
- `README.md`

The review covers internal consistency, security, failure behavior, API completeness, operations, and testability.

## Severity Model

| Severity | Meaning |
|---|---|
| Critical | The design can cause credential loss, unauthorized access, duplicate external actions, or a blocked implementation. |
| High | The design omits behavior that affects correctness, compatibility, recovery, or a primary success criterion. |
| Medium | The design leaves an important operational or maintenance choice undefined. |
| Low | The design has a local clarity, terminology, or verification problem. |

## Executive Summary

The local and shared layer split is useful. The explicit memory proposal path also gives a good architectural boundary.

The remote registry invalidates the stated trust model. It can select commands, endpoints, environment variables, and secret files on each workstation.

The shared services provide authentication but do not define authorization. A caller can supply another project's identity or memory scope.

The task lease does not guarantee one response. An expired lease can let two responders complete the same external action.

Phase 1 also depends on the Phase 2 coordination service. The default ingress path and a main success criterion require that service.

Resolve the critical findings before an implementation plan. Define the protocol contracts before service development starts.

## Critical Findings

### F01. A remote registry can execute commands and select local secrets

**Evidence:** The registry supports `stdio_cmd`, `stdio_npx`, `command`, `args`, and `env` in service contracts lines 34-54.

The same registry selects environment variables and file paths in lines 56-72. The hub fetches this registry from a shared URL.

**Impact:** A registry compromise can start arbitrary commands. It can also send selected workstation secrets to an attacker endpoint.

Rejecting only a remote `literal` value does not prevent these attacks. The claim that central curation needs no trust is incorrect.

**Required change:** Define a local trust policy for every remote registry.

- Prohibit remote `stdio_cmd` and `stdio_npx` entries by default.
- Require a local allow-list for commands, packages, endpoints, environment variables, and secret paths.
- Pin the registry origin and require HTTPS.
- Define signature verification or an equivalent integrity control.
- Require local approval for new or changed privileged entries.
- Preserve the last accepted registry when validation fails.

### F02. Project isolation has no authorization basis

**Evidence:** Collaboration clients submit `projectKey`, branch, owner, and `agentId` values. One shared bearer token authenticates the service.

The memory worker also trusts caller-supplied `scopeIds`. The specifications do not bind a token to a project, owner, or allowed scope.

**Impact:** An authenticated client can impersonate another agent. It can also read another project's channels or memory.

This omission conflicts with the isolation rules and success criteria. See collaboration lines 18-44 and service contracts lines 275-290.

**Required change:** Define a principal and authorization model.

- Bind each credential to an owner and allowed project set.
- Derive readable and writable scopes from the authenticated principal.
- Reject caller-selected scopes outside that set.
- Protect agent registration against `agentId` replacement.
- Define administrator actions separately from agent actions.
- Add denial tests for every cross-project operation.

### F03. A claim lease does not give exactly-once replies

**Evidence:** The main design says that a lease guarantees exactly one responder. The collaboration spec repeats this claim.

A responder can complete a Slack reply after its lease expires. A second responder can then claim the same task and reply again.

**Impact:** Users can receive duplicate messages. Other channel actions can also occur more than once.

**Required change:** State an at-least-once delivery contract. Add idempotency and fencing for external effects.

- Give each claim a monotonic fencing token.
- Require the token for heartbeats and completion.
- Reject completion from an expired claim.
- Store an idempotency key for each channel action.
- Define responder behavior after an ambiguous provider timeout.
- State which provider operations support safe retries.

### F04. Phase 1 requires a Phase 2 service

**Evidence:** Coordination is marked Phase 2 in the repository structure and compose example. Ingress uses its task board by default.

The main success criteria also require a responder to claim an ingress task. See main design lines 302-320, 400-417, and 562-564.

**Impact:** The Phase 1 boundary cannot produce the documented default channel behavior.

**Required change:** Select one phase model.

- Move the minimal task board into Phase 1 and defer only agent collaboration.
- Alternatively, make direct callback the Phase 1 default and revise the success criteria.
- Define the responder deliverable for the selected phase.

### F05. The shared layer credential claim is false

**Evidence:** The design says that the shared layer holds zero credentials. The shared responder holds bot tokens.

Ingress must also hold Slack signing secrets, GitHub webhook secrets, and callback credentials. See main design lines 102-109 and 246-261.

**Impact:** Operators can apply an incorrect threat model. They can omit secret storage, rotation, and access controls.

**Required change:** Limit the claim to upstream MCP credentials. Document every shared secret and its rotation process.

Update the README statements at lines 40-41 and 62-63. Distinguish engineer credentials from service credentials.

### F06. Channel events do not have a task contract

**Evidence:** The task board uses `JobSpec` and `JobResult`. Ingress puts `ChannelEvent` objects on the same queue.

No union type, discriminator, payload wrapper, or result type joins these shapes. Claimer eligibility is also undefined.

**Impact:** Implementers cannot validate, route, claim, or complete ingress tasks consistently.

**Required change:** Define a versioned task envelope.

- Add a discriminator for `delegated_job` and `channel_event`.
- Define source payloads and results.
- Define required capabilities and allowed principals.
- Define queue filters and claim eligibility.
- Prevent local agents from claiming team events unless routing permits it.

### F07. Direct memory writes bypass the stated memory policy

**Evidence:** The memory API includes `POST /memories/upsert`. The channel contract says that agents never write durable memory directly.

The specifications do not restrict the direct endpoint to an administrator or publication worker.

**Impact:** An agent can bypass extraction, policy checks, reconciliation, and scope restrictions.

**Required change:** Remove the endpoint from the agent surface. Alternatively, require a separate administrative principal.

Define the exact caller for organization publication. Apply validation, audit records, and scope authorization to all direct mutations.

## High Findings

### F08. Local OAuth behavior is absent

The design describes the hub as an OAuth client. The credential model supports static bearer, header, basic, and environment values only.

Running the hub locally removes central custody. It does not remove authorization, refresh, consent, revocation, or token storage.

Define supported OAuth flows and callback handling. Otherwise, state that Phase 1 accepts pre-provisioned static credentials only.

### F09. Service protocol contracts are incomplete

The documents list endpoints and tool names. They do not define most request schemas, response schemas, status codes, or error bodies.

The missing contracts include memory routes, ingress routes, coordination routes, and the three CodeMode tools.

Define versioned JSON schemas. Define size limits, timeouts, cancellation, pagination, idempotency, and error codes.

### F10. Remote redirect and network access rules are unsafe

The hub follows redirects and injects downstream credentials. The specifications do not restrict redirect origins or private network targets.

A redirect can expose a credential if the client retains its authorization header. A registry entry can also request local network resources.

Strip credentials before each redirect decision. Reject cross-origin redirects unless a local policy permits them.

Define DNS rebinding controls and private address rules. Apply the same policy during probes and normal calls.

### F11. Config refresh has no transaction contract

The hub reloads the registry every 900 seconds. The design does not define add, change, removal, or validation behavior.

It also does not define active call behavior or credential refresh. A malformed update can create partial state.

Validate a complete candidate registry first. Swap it atomically after all policy checks pass.

Define namespace draining, subprocess termination, cache invalidation, and rollback behavior.

### F12. MCP session behavior needs a compatibility decision

Repo conventions create a fresh Streamable HTTP server transport per request. Remote proxies also create a fresh client per call.

The design supports SSE and Streamable HTTP but does not define session identifiers, reconnects, notifications, or server-initiated messages.

Specify the supported MCP transport features. Add compatibility tests against stateful and stateless upstream servers.

### F13. Ingress delivery and deduplication are incomplete

A random fallback key prevents key collapse. It does not deduplicate a provider retry.

The specifications do not define ingress acknowledgments, queue retry policy, timeout behavior, or coordination outages.

Require a stable provider delivery identifier when possible. Define a deterministic fallback with an explicit collision and replay policy.

Persist accepted events before acknowledgment. Define retention and retry limits.

### F14. Webhook defenses omit replay and resource controls

The adapters verify a secret or signature. They do not define timestamp checks, replay windows, body limits, parsing limits, or rate limits.

Define these controls for each adapter. Specify canonical signature inputs and constant-time comparison.

Include Slack challenge handling and GitHub delivery behavior. Reject oversized or stale requests before expensive processing.

### F15. The task state machine is not implementable

The task board lacks state definitions, lease duration, heartbeat interval, attempt limits, and terminal state behavior.

Cancellation, poison tasks, priority bounds, completion idempotency, and expired result handling are also absent.

Define a complete state transition table. Define one transaction boundary for claim, heartbeat, completion, and lease recovery.

### F16. SSE replay lacks cursor expiry behavior

Messages have a seven-day lifetime. A client can reconnect with a cursor that points before the retained range.

The design does not define the response for that case. It also omits ordering, event identifier stability, and backpressure.

Define an expired cursor response and a resynchronization procedure. Define per-channel ordering and connection limits.

### F17. Memory can disclose secrets before the banlist runs

The worker sends the proposal to the extraction model before it validates extracted candidates. A remote extractor can receive proposal secrets.

The prompt prohibition and output banlist do not protect the input. The policy file also enters the extractor prompt.

Define input classification and redaction before extraction. State whether remote extractors can receive repository content.

### F18. Memory conflict resolution can preserve the wrong fact

For a new value in one identity slot, the highest confidence value wins. Equal confidence and newer authoritative corrections are undefined.

Confidence is model-generated and is not an authority signal. The rule can retain an old value over a human correction.

Define provenance priority, observation time, explicit correction, and equal-confidence behavior. Preserve a queryable revision trail.

### F19. The embedding decision blocks interoperability

The embedding function remains an open question in the main design. Chroma records depend on its model and vector dimension.

A later change can make stored vectors incompatible. It can also make different deployments return different results.

Select the Phase 1 embedding provider. Store model identity and dimension with each collection schema.

Define migration behavior for a model change.

### F20. Organization publication has no ingestion contract

The design says that an ingestion job reads `.agentframe/public.md`. It does not define discovery, authentication, parsing, or deletion transactions.

It also does not define repository revision tracking or failure recovery. Partial replacement can remove valid organization facts.

Define the publication source, principal, record format, revision key, and atomic replacement behavior.

### F21. Provisioning uses mutable, unpinned executable dependencies

The installer uses an unversioned global npm package. Skill entries contain only repository names, and every run updates them.

This behavior is not reproducible. It also expands the workstation supply-chain risk.

Pin the CLI version and each skill revision. Verify checksums or signed commits where available.

Make updates an explicit command. Keep installation idempotent against the lock file.

### F22. Provisioning can overwrite user-managed instructions and hooks

The sync tool writes complete files into existing harness locations. It also owns the complete `hooks` key.

The design does not require backups, managed markers, atomic writes, or conflict detection. Existing user instructions and hooks can disappear.

Use managed blocks where each harness supports them. Preserve unrelated content and hook entries.

Create a backup before the first mutation. Provide dry-run and restore modes.

### F23. Team token distribution is promised but not designed

Service contracts state that provisioning distributes a team token. The provisioning spec contains no secret distribution mechanism.

This omission also conflicts with the stated credential boundary. A template sync tool must not copy secrets into instruction files.

Remove the claim or define a separate secret manager integration. Keep secret distribution outside instruction composition.

### F24. The compose example cannot satisfy its own security rules

The compose example publishes shared service ports on all host interfaces. Ingress has no bearer token or provider secret variables.

The responder service is absent. Registry and tool catalog serving are also absent.

The success criteria say that an empty registry is the only required configuration. D7 requires bearer tokens for exposed services.

Define secure bind defaults and required startup values. Make the example internally executable or label it as schematic.

## Medium Findings

### F25. Readiness and liveness semantics are reversed

`GET /readyz` always returns 200, even when the service is not ready. Operators then use it as the load-balancer readiness target.

This endpoint is a liveness check under common operational semantics. It can route traffic to an unusable instance.

Use `/livez` for the shallow check. Make `/readyz` report required dependency and startup state.

### F26. Operational durability is unspecified

SQLite, Chroma, memory manifests, and queue files contain durable state. Backup, restore, migration, corruption, and disk-full behavior are absent.

Define schema migrations and startup recovery. Document backup consistency and restore tests.

Define retention values for queue entries, failed tasks, manifests, Chroma tombstones, and audit records.

### F27. Observability has no contract

The specifications define log redaction but omit request identifiers, metrics, traces, and audit events.

Operators need queue depth, claim expiry, extraction duration, upstream health, retry counts, and rejected authorization counts.

Define a small metric set and structured log schema. Propagate correlation identifiers across ingress, coordination, responders, and memory proposals.

### F28. Token fingerprints can expose low-entropy secrets

A plain 12-character SHA-256 prefix allows cross-log correlation. It can also aid offline checks for weak secrets.

Use a deployment-specific keyed hash if correlation is necessary. Otherwise, omit token fingerprints.

### F29. Dependency and image versions are not reproducible

The compose example uses `chromadb/chroma:latest`. The documents do not set Bun, SDK, SQLite, or image version floors.

The selected model reference can also change outside this repository. Pin images by digest and dependencies through lock files.

Record the model artifact hash. Define the supported upgrade process.

### F30. Workspace identity normalization is incomplete

The normalization rule does not cover SCP-style Git URLs, ports, trailing slashes, multiple remotes, or repository aliases.

Lowercasing the complete path can also merge distinct repositories on a case-sensitive host. Branch names require safe channel encoding.

Define canonical test vectors. Prefer an explicit project identifier from trusted configuration when remote normalization is ambiguous.

### F31. Memory taxonomy and storage routing do not align

The extraction taxonomy lists `fact`, `decision`, `person`, and `preference`. Collection routing also references `episode` and raw episodes.

Patterns use separate manifests, but their Chroma storage behavior is unclear. Define every persisted record type and collection.

### F32. The policy file failure mode is unsafe

A missing memory policy produces a warning and permits startup. The resulting extraction policy is not defined.

Define a secure built-in policy or fail startup. Do not allow an undefined policy for network-exposed production use.

### F33. The test strategy is too narrow

The success criteria cover happy paths and selected isolation cases. They omit negative, recovery, concurrency, and compatibility tests.

Add a contract test matrix for each service. Include malformed input, denied access, retries, crashes, stale leases, and version changes.

Add end-to-end tests for registry compromise, duplicate provider delivery, extractor failure, and shared service recovery.

## Low Findings

### F34. Normative language is inconsistent

The documents mix `must`, `should`, descriptive text, and recommendations without a defined requirement vocabulary.

Define `MUST`, `SHOULD`, and `MAY`, or use one consistent requirement form. Give stable identifiers to testable requirements.

### F35. Several claims need measured acceptance limits

Claims such as CPU-friendly, near 50 engineers, and far beyond 15 have no workload or hardware basis.

Replace them with benchmark targets. State hardware, payload size, concurrency, latency, and queue growth limits.

### F36. The specification set lacks ownership and change control

The documents have dates but no status, owner, approval, version, or supersession metadata.

Add a short metadata block. Record decision changes in an architectural decision record or a change log.

## Strengths To Preserve

- The design separates workstation credentials from shared upstream access.
- The hub has explicit upstream configuration and no vendor defaults.
- The memory pipeline uses proposals instead of direct agent writes.
- The filesystem queue describes atomic claims and temporary-file writes.
- The design keeps the last good tool cache after discovery failures.
- The project and organization memory scopes have a small conceptual model.
- Human-reviewed organization publication avoids unowned automatic summaries.
- The service construction pattern supports dependency injection and isolated tests.
- The pitfall register records design history and prevents repeated mistakes.
- The container boundary keeps the framework independent of an agent runtime.

## Required Contract Additions

Add these documents before implementation starts:

1. `security-model.md`: Principals, trust boundaries, authorization, secret custody, and registry trust.
2. `protocol-contracts.md`: Versioned HTTP and MCP schemas, errors, limits, and idempotency.
3. `task-state-machine.md`: States, leases, fencing, retries, cancellation, and channel effect rules.
4. `operations-contract.md`: Readiness, persistence, migration, backup, retention, and observability.
5. `provisioning-safety.md`: Lock file, update process, managed file rules, backup, and restore.
6. `acceptance-matrix.md`: Requirement identifiers and positive, negative, recovery, and concurrency tests.

These can become sections in existing specifications. Separate files can make ownership and review easier.

## Recommended Resolution Order

1. Fix the trust model in F01, F02, and F05.
2. Select the phase boundary in F04.
3. Define the task envelope and state machine in F03, F06, and F15.
4. Define all public protocols in F07 through F14.
5. Complete the memory decisions in F17 through F20 and F31 through F32.
6. Make provisioning reproducible and non-destructive in F21 through F23.
7. Complete operations and acceptance work in F24 through F36.

## Implementation Readiness Gate

The specification set becomes implementation-ready when all critical findings have approved resolutions.

All public interfaces must then have versioned schemas. Every security rule must also have at least one denial test.

The compose example must start with documented inputs. It must satisfy the same authentication and readiness rules as the service contracts.
