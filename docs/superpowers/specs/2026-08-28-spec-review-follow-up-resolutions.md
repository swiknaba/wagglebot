# Follow-Up Review Resolutions

> Dispositions for the 33 findings in
> [2026-08-28-spec-review-follow-up.md](2026-08-28-spec-review-follow-up.md).
> Round 1 dispositions stay in
> [2026-08-28-spec-review-resolutions.md](2026-08-28-spec-review-resolutions.md).

## The Model Correction

The follow-up review makes one structural correction, and the
correction is right.

Round 1 finding F02 asked for project-level authorization. That request
assumed an untrusted multi-tenant service. The real deployment is one
company of trusted coworkers, and Git already controls code access. My
round 1 resolution therefore built an access-control model that does
not fit.

**D15 replaces it.** Identity now serves routing, context, and
attribution. Teams and scopes select defaults, never permissions. Two
restrictions remain, and both are justified:

* Impersonation protection. A token binds to one username, so
  attribution stays correct.
* Operator actions. Central files, token rotation, and direct memory
  mutation need the operator token.

`principals.json` becomes `users.json` plus `teams.json`, maintained by
the managers in the central repository. Repository write access is the
only permission system (P34).

## Blocking Findings

| # | Disposition |
|---|---|
| G01 | **Open, blocking.** D19 records the required metadata (provider, model, artifact revision, dimension, distance function, schema version) and the migration duty. The provider choice needs your decision. |
| G02 | **Accepted.** Four contract documents stay pre-implementation deliverables. The trust model consolidates into `security-model.md`. |
| G03 | **Resolved.** One user token for every shared service. Lowercase Git username. `users.json` supports add, remove, team change, and token replacement. No audiences, issuers, or per-service tokens. |
| G04 | **Resolved, scoped.** Channel effects pass through the durable effect path in ingress: store before send, reject a stale fence, deduplicate on the idempotency key, record the provider request id, mark ambiguous timeouts `unknown`. **Scoped down:** no separate effect microservice, and no per-provider reconciliation engine in Phase 1. |
| G05 | **Resolved, scoped.** The worker scrubs proposal **input** before every extractor call: secret detection, redaction, policy version on the job, rejection without echoing content. **Scoped down:** no data-class taxonomy and no per-class provider allow-list. Those need a governance program the org does not run. |
| G06 | **Resolved.** D18 ships a minimal reference responder in Phase 1. |

## Specification Inconsistencies

All seven were verified against the files before the fix. All were real.

| # | Disposition |
|---|---|
| G07 | **Fixed.** Contracts §C6 now uses `/livez` and `/readyz` per D8. The `/health` endpoint is gone. |
| G08 | **Fixed.** Success criterion 6 permits shared service secrets, and still prohibits engineer and upstream credentials. The README principle is revised. |
| G09 | **Fixed.** Criterion 1 lists the registry, the generated service tokens, and optional connector secrets. |
| G10 | **Fixed.** The design refers to the keyed fingerprint rule in §C2. |
| G11 | **Fixed.** The sync tool owns only entries with an agentframe identifier. |
| G12 | **Fixed.** See the model correction above (D15). |
| G13 | **Fixed.** The P6 guard states the built-in default policy. |
| G14 | **Fixed.** The compose example pins a digest placeholder. |

## Trust Model Requirements

| # | Disposition |
|---|---|
| G15 | **Resolved.** D15. The registry selects relevance, not permission. Local credentials decide what works. |
| G16 | **Resolved.** Cross-team discovery, messaging, and handoff are available to every registered engineer. A connection rejection is a user preference (P34). |
| G17 | **Resolved.** The runtime owns permission enforcement. Agentframe transports `JobSpec` and never sandboxes a job. |
| G18 | **Deferred** to `operations-contract.md`. The field list is adopted as the requirement. |
| G19 | **Resolved, scoped.** P32: size caps, control-character stripping, provenance tags, first-party routing catalog. **Scoped down:** no formal change-review workflow for descriptions in Phase 1. |

## Multi-Team Organization Requirements

| # | Disposition |
|---|---|
| G20 | **Resolved.** D16 separates team, project, user, and agent identifiers. |
| G21 | **Resolved.** `users.json` and `teams.json` in the central repository. Managers maintain them. |
| G22 | **Resolved.** Two layers only: `registry.base.json` and `registry.team.<team>.json`. Team wins per namespace. Validation prints the effective registry. |
| G23 | **Resolved.** Cross-team collaboration is the default. Scopes select channels and relevance. |
| G24 | **Partial.** The published-interface field list is adopted for `.agentframe/public.md`. The searchable catalog schema goes to `protocol-contracts.md`. |
| G25 | **Resolved.** D16: `.agentframe/project.json` overrides remote normalization, which covers monorepositories, aliases, and renames. A branch is context, never identity. |
| G26 | **Resolved.** Eligibility gains `team:`, `project:`, and a capability set. FIFO and priority hold inside the eligible set. |
| G27 | **Resolved.** D17 and `channels.json`. An unrouted or ambiguous event is rejected, never guessed. |
| G28 | **Resolved.** One operator procedure: edit the central files, issue or revoke one token, run validation. |
| G29 | **Deferred** to Phase 2, with the field list adopted. Summaries stay operational, and never expose project working memory. |
| G30 | **Deferred** to `operations-contract.md`. |
| G31 | **Accepted.** The acceptance profile (3 managers, 2–5 teams each, multiple projects, cross-team publication, concurrent traffic, one shared stack) replaces the capacity estimates. Set measured limits after the first working implementation. |
| G32 | **Resolved.** One validation command over users, teams, projects, registries, and channel routes. |
| G33 | **Accepted.** Operators own model and data policy. Agentframe keeps only vector-compatibility metadata, the external extractor flag, deletion, retention, and backup behavior. |

## Where These Resolutions Push Back

The review is sound. Three items are **scoped down**, not rejected,
because the full version does not fit a fifteen-engineer internal tool:

1. **G04 — no separate effect service.** The durable record, the fence
   check, and the idempotency store give the real protection. A
   dedicated microservice and a per-provider reconciliation engine add
   deployment surface without changing the outcome. Ingress already
   owns the provider credentials, so the effect path belongs there.
2. **G05 — no data-class policy engine.** Secret detection and
   redaction close the disclosure path. Data classes, per-class
   provider allow-lists, and policy attestation need a governance
   program that this organization does not run.
3. **G19 — no description review workflow.** Caps, sanitization, and
   provenance stop the injection vector. A human review queue for every
   upstream description change would not survive contact with real use.

One process note. The review says "do not start the implementation
plan." That is correct for **service implementation**. Writing the plan
is how the four contract documents get scheduled, so planning may start
once G01 has an answer.

## Remaining Gate

| Gate | State |
|---|---|
| Embedding provider decision (G01, D19) | **Open — needs your call** |
| `protocol-contracts.md` | Deliverable |
| `task-state-machine.md` | Deliverable |
| `operations-contract.md` | Deliverable |
| `acceptance-matrix.md` | Deliverable |
| `security-model.md` (consolidation) | Deliverable |
| Everything else from both reviews | Resolved in the specs |
