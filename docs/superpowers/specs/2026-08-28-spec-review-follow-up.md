# Agentframe Specification Follow-Up Review

**Review date:** 2026-08-28  
**Audience:** Implementation agents, reviewers, and architecture owners.  
**Status:** Blocking findings remain open. Do not start the implementation plan yet.

## Scope

This review checks the revised specifications after the first review.

It covers:

- The disposition of all 36 original findings.
- New inconsistencies introduced during resolution.
- Remaining implementation blockers.
- Company requirements that the current design does not cover.

The target deployment is a self-operated engineering organization:

- Approximately three engineering managers.
- Approximately two to five teams per manager.
- Multiple repositories and interfaces across teams.
- One shared Agentframe stack.
- One local hub per participating engineer.

Enterprise identity, high availability, regulatory governance, and managed-service features are out of scope.

All registered engineers are trusted coworkers. Team and project data supports routing, context, and collaboration.

Agentframe does not use team membership to control source code access.

## Current Assessment

The revision resolves important trust, phase, and provisioning problems.

The resolution ledger reports these dispositions:

| Disposition | Count |
|---|---:|
| Resolved | 17 |
| Partial | 2 |
| Deferred | 16 |
| Accepted estimate | 1 |

Nineteen findings are not fully closed. The embedding decision is explicitly blocking.

Four required contract documents also remain absent. The implementation agent must not infer their behavior from descriptive prose.

## Positive Changes

- The remote registry now has a local trust policy.
- The task board now uses at-least-once delivery terminology.
- Claims now include monotonic fencing tokens.
- Task entries now have a versioned envelope and discriminator.
- The task board core now ships in Phase 1.
- The shared-layer secret statement now distinguishes engineer secrets from service secrets.
- Direct memory mutation now uses a separate operator endpoint.
- Provisioning dependencies now require pinned versions.
- Agent instruction synchronization now includes backup and dry-run behavior.
- Liveness and readiness now have separate intended meanings.

Preserve these decisions during implementation.

## Blocking Findings

### G01. Select the Phase 1 embedding provider

**Evidence:** The main design still asks whether Chroma or the extractor endpoint supplies embeddings.

**Impact:** Collection dimensions, query compatibility, migrations, and deployment behavior remain undefined.

**Required decision:** Select one provider and model for Phase 1.

Store this metadata with each collection:

- Provider identifier.
- Model identifier.
- Artifact or revision identifier.
- Vector dimension.
- Distance function.
- Schema version.

Define a rebuild or migration process for every model change.

### G02. Write the deferred contracts before implementation planning

The resolution ledger requires these documents:

1. `protocol-contracts.md`.
2. `task-state-machine.md`.
3. `operations-contract.md`.
4. `acceptance-matrix.md`.

The trust model also needs one consolidated source. Existing trust rules span multiple specifications.

Each contract must use stable requirement identifiers. Each mandatory rule must map to an acceptance test.

### G03. Keep user identity simple

The earlier review recommended separate tokens for each shared service. That recommendation does not fit this trust model.

Use one user token across the shared services. The token identifies the engineer and their teams.

Use the company Git username as `username`. The company convention makes this value unique.

Store the username in lowercase. Do not use a display name or email address.

The engineering managers maintain the user list in the central repository.

Use one small file:

```json
{
  "users": [
    { "username": "alice", "tokenHash": "...", "teams": ["payments"] }
  ]
}
```

Support these operations:

- Add a user.
- Remove a user.
- Change team membership.
- Replace a lost token.

Do not add token audiences, token issuers, identity providers, or service-specific user tokens.

### G04. Make external effects durable and idempotent

**Evidence:** A fencing token prevents stale task completion. It does not prevent a stale responder from sending a message.

An external provider might not support the supplied idempotency key. A timeout can also leave the result unknown.

**Impact:** Slack messages, GitHub comments, and other actions can occur more than once.

**Required design:** Put channel effects behind one durable effect service or channel adapter.

The adapter must:

- Store the effect before transmission.
- Enforce one local idempotency record.
- Record the provider request identifier.
- Reconcile ambiguous timeouts.
- Prevent transmission from an expired fence.
- Define provider-specific retry behavior.
- Preserve a complete effect audit record.

Do not claim one external reply until each provider contract proves that behavior.

### G05. Protect extractor input before external transmission

**Evidence:** `EXTRACTOR_ALLOW_EXTERNAL=1` acknowledges external disclosure. It does not reduce the disclosed data.

**Impact:** Proposals can send credentials, personal data, source code, or regulated data to an external model.

**Required design:** Add input controls before the extractor call.

- Detect secrets and prohibited data.
- Apply project data policy.
- Redact or reject matching content.
- Record the applied policy version.
- Report rejected proposals without sensitive content.
- Require an allowed provider for each data class.

### G06. Provide a usable responder deliverable

**Evidence:** Phase 1 success requires a responder. The project ships only a skeleton and a contract.

**Impact:** The default ingress path cannot demonstrate a complete reply flow.

Choose one requirement:

- Ship a minimal reference responder.
- Ship a responder conformance kit and require an external runtime during acceptance tests.

The deliverable must support claims, heartbeats, fences, effect submission, cancellation, and memory proposals.

## Specification Inconsistencies

### G07. Health endpoint descriptions conflict

D8 defines `/livez` as shallow. It defines `/readyz` as dependency-aware.

Service contracts section C6 still calls `/readyz` shallow. It also retains the old `/health` endpoint.

Update C6 to use only the D8 convention.

### G08. Shared secret claims still conflict

Main success criterion 6 says that no secret appears in the shared layer.

D9 correctly states that the shared layer holds bot tokens, signing secrets, and service tokens.

The central Slack integration needs these secrets:

- The ingress service needs `SLACK_SIGNING_SECRET` to verify Slack requests.
- The responder needs `SLACK_BOT_TOKEN` to send Slack replies.

Other channel adapters need equivalent provider secrets. For example, GitHub ingress needs a webhook secret.

Store these secrets outside the Git repository. Inject them through deployment environment variables or mounted secret files.

For a small self-operated stack, a gitignored `.env.shared` file is sufficient. Apply restrictive file permissions.

Give each secret only to the service that needs it. Do not put a provider secret in `registry.json`.

The local MCP hub must not receive shared channel secrets. The shared ingress and responder services use them.

Change success criterion 6 to permit shared service secrets. Continue to prohibit engineer and upstream MCP credentials in the shared layer.

Revise the README principle as follows:

> Engineer and upstream MCP credentials stay on each workstation. Shared channel secrets stay in the shared deployment.

### G09. Required startup configuration is understated

Main success criterion 1 says that an empty registry is the only required configuration.

D7 requires authentication for exposed services. Ingress and responders also need provider secrets.

List the exact solo and team startup inputs. Separate mandatory values from optional connector values.

### G10. Fingerprint algorithms conflict

The main design still specifies a 12-character SHA-256 fingerprint.

Service contracts section C2 now specifies keyed HMAC-SHA256 or omission.

Use the service contract rule everywhere.

### G11. Hook ownership statements conflict

Provisioning distribution rules preserve hook entries that Agentframe did not create.

The later hook section says that the tool owns the complete `hooks` key.

Remove complete-key ownership. Track only entries with stable Agentframe identifiers.

### G12. Simplify the principal model in the specifications

The collaboration specification treats team and project data as access-control rules.

The intended model uses these values for routing and context. All registered engineers are trusted coworkers.

Replace the principal model with the user file from G03. Keep separate secrets only for external providers and service processes.

### G13. Pitfall guards contain old behavior

P6 still says that a missing policy only produces a warning.

The memory contract now selects a built-in policy. Update the P6 guard to state that behavior.

### G14. The schematic compose block conflicts with pinned dependency policy

D13 prohibits `latest` dependencies. The schematic compose block still uses `chromadb/chroma:latest`.

Even a schematic example can become copied production configuration. Replace it with a digest placeholder.

## Trust Model Requirements

### G15. Use team data for routing only

Do not add team-based tool authorization. Every registered engineer can use the configured tool catalog.

Local credentials still determine which upstream tools work for one engineer.

Use team data for these functions:

- Select the effective team registry.
- Route tasks and channel events.
- Find coworkers.
- Add context to messages and memory.

### G16. Allow collaboration across all registered teams

Do not require team-to-team grants. Registered engineers can discover coworkers, send messages, and hand off tasks.

Team and project values select the default channel. They do not deny cross-team collaboration.

A person can reject a direct connection request as a user preference. This rejection is not an access-control rule.

### G17. Keep job execution outside Agentframe

Agentframe transports `JobSpec` data. The selected agent runtime executes the job.

Document that the runtime owns permission enforcement. Do not build a job sandbox in Agentframe.

### G18. Add a durable activity log

Small teams still need to diagnose actions. Record these facts:

- Registered user and service identity.
- Agent, machine, project, and branch.
- Task and claim fence.
- Model and policy versions.
- Selected tool and normalized arguments.
- Connection preferences and registry approvals.
- External effect and provider result.
- Correlation identifier.

Define redaction, retention, and administrator access. Advanced audit integrations are out of scope.

### G19. Treat tool descriptions as untrusted input

Remote tool descriptions and routing catalogs can contain prompt injection.

The registry trust policy protects commands and credentials. It does not govern descriptive tool content.

Add:

- Schema size and character limits.
- Content sanitization.
- Change review for routing instructions.
- Provenance for every tool description.
- A policy boundary between descriptive text and executable selection.

## Multi-Team Organization Requirements

### G20. Make teams first-class routing units

The current design treats `projectKey` as the primary collaboration boundary.

A team can own multiple repositories. One repository can also contain software from multiple teams.

Define separate identifiers for:

- Team.
- Project or repository.
- Agent and engineer.

Map projects to owning teams explicitly. Do not derive team identity from a Git remote.

### G21. Store manager and team assignments

Use versioned files in the central repository.

Store these relationships:

- An engineering manager manages two to five teams.
- An engineer belongs to one or more teams.
- A team owns one or more projects.
- A project can have more than one owning team.

Repository write access controls who can change these files. Agentframe needs no management role system.

### G22. Keep registry composition small

Use the existing organization and team layers:

```
registry.base.json
registry.team.<team>.json
```

Define merge precedence and conflict behavior. Show the effective registry during validation.

### G23. Enable cross-project collaboration by default

Different `projectKey` values are currently invisible by default.

That rule blocks normal work between teams whose software has interfaces.

All registered engineers can:

- Team discovery.
- Messages.
- Task handoff.

Published interfaces remain visible through the organization scope.

Project memory scopes improve search relevance. They do not form a code-access boundary.

### G24. Make the published interface catalog searchable

`.agentframe/public.md` is a strong starting point. Define a useful multi-team catalog around it.

Each published interface needs:

- Owning team.
- Repository and source revision.
- Interface name and summary.
- Endpoints or events.
- Authentication description.
- Compatibility or version information.
- Contact and escalation path.
- Dependencies on other team interfaces.

Provide search by team, interface, event, endpoint, and owner.

### G25. Support multiple repositories and monorepositories

Define these mappings:

- One team to many repositories.
- Many teams to one monorepository.
- One engineer to many active projects.
- Repository aliases after a move or rename.

Do not use the current Git branch as the only agent workspace identity.

### G26. Route tasks by team and capability

The task envelope routes to a shared responder, one owner, or any agent.

Add eligibility for:

- A team.
- A required capability set.
- A specific project.

Define selection when several eligible agents are available. Preserve FIFO and priority behavior within the eligible set.

### G27. Define channel-to-team routing

Slack channels and GitHub repositories need explicit ownership mappings.

Define a routing file that maps an ingress source to:

- Organization and team.
- Project.
- Default responder.
- Allowed event types.
- Reply identity.

Reject an event when its route is ambiguous. Do not guess from message text.

### G28. Keep onboarding and offboarding simple

Provide one operator procedure for:

- Adding a manager.
- Adding a team.
- Adding an engineer.
- Assigning projects.
- Issuing one user token.
- Removing access.
- Rotating a lost token.

The procedure can update versioned files and restart services.

### G29. Give managers useful visibility

Managers need operational visibility across their teams. They do not need unrestricted working-memory access.

Provide summaries for:

- Active agents.
- Queued and failed tasks.
- Cross-team handoffs.
- Unanswered channel events.
- Registry and publication freshness.
- Service health.

Do not expose private project memory through these summaries.

### G30. Define basic self-operation

The target is one self-operated shared instance.

A small self-operated stack still needs:

- Documented startup and shutdown.
- Health checks.
- Backup and restore commands.
- Disk-space warnings.
- Failed-job inspection and retry.
- Versioned upgrades and rollback.
- One correlation identifier across services.

### G31. Test the intended organization size

Replace unsupported scale estimates with one acceptance profile.

The profile must include:

- Three engineering managers.
- Two to five teams per manager.
- Multiple projects per team.
- Cross-team interface publication.
- Concurrent task and message traffic.
- One shared stack.

Set measured limits after the first working implementation. Use the results to document supported team and project counts.

### G32. Validate central configuration files

Engineering managers maintain the central files through normal repository changes.

Provide one validation command. It checks users, teams, projects, registries, and channel routes.

The command shows the effective configuration and reports conflicts. An administration service is out of scope.

### G33. Keep model and data policy operator-owned

Operators select models, providers, retention rules, and deployment boundaries.

Agentframe only needs:

- Model metadata required for vector compatibility.
- Explicit external extractor configuration.
- Basic record deletion and retention.
- Clear backup behavior.

Company governance systems, regulatory controls, and model approval programs are out of scope.

## Required Implementation Gates

Do not start implementation until these gates pass:

- [ ] Select and document the Phase 1 embedding provider.
- [ ] Complete `protocol-contracts.md`.
- [ ] Complete `task-state-machine.md`.
- [ ] Complete `operations-contract.md`.
- [ ] Complete `acceptance-matrix.md`.
- [ ] Document the trusted coworker model.
- [ ] Define the central user and team files.
- [ ] Define the durable external effect path.
- [ ] Resolve G07 through G14 in the existing specifications.
- [ ] Select the responder deliverable.

- [ ] Define the manager, team, and project mapping.
- [ ] Define default cross-team collaboration.
- [ ] Define channel ownership and routing.
- [ ] Define the intended organization acceptance profile.

## Recommended Work Order

1. Resolve all specification inconsistencies.
2. Select the embedding provider and responder deliverable.
3. Define user identity, team routing, and project mapping.
4. Define the task state machine and durable effect path.
5. Define every HTTP and MCP protocol.
6. Define operations, persistence, and recovery.
7. Create the acceptance matrix.
8. Create the Phase 1 implementation plan.
9. Validate the design against the intended multi-team organization.

## Implementation-Agent Directive

Treat this document and the original review as specification inputs.

Do not fill a missing contract with an implementation assumption. Record the gap and request an architecture decision.

Do not add access controls that the trusted coworker model does not require.

Do not claim exactly-once external behavior. Prove provider behavior and implement durable local deduplication first.
