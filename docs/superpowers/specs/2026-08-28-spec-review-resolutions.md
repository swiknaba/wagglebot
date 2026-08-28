# Spec Review Resolutions

> Dispositions for the 36 findings in
> [2026-08-28-spec-review.md](2026-08-28-spec-review.md).
>
> **Resolved** = the specs now state the required behavior.
> **Deferred** = accepted, and assigned to a named pre-implementation
> deliverable. **Partial** = the decision is resolved, and the detail is
> deferred.

## Critical

| # | Disposition | Where |
|---|---|---|
| F01 | **Resolved.** Registry trust policy: pinned HTTPS origin, local approval for privileged entries (`registry.trust.json`), validate-then-swap, keep last accepted. Pinned `stdio_npx` versions (D13). The "no central trust" claim is corrected. | Contracts §C2, design D13, P29, P31 |
| F02 | **Resolved.** Principal model: `principals.json`, token→username binding, project sets from teams, `agentId` protection, separate administrator token, denial tests. | Collaboration spec, contracts §C3 |
| F03 | **Resolved.** At-least-once contract: fencing tokens on claim/heartbeat/completion, idempotency keys on external effects. The exactly-once claims are removed. | D5, collaboration spec, contracts §C5, P30 |
| F04 | **Resolved.** D14: the task board core (queue, claim, lease, fence) moves to Phase 1. Presence, messaging, and collaboration stay Phase 2. | Design D14, §6 |
| F05 | **Resolved.** D9 now names the shared service secrets (bot tokens, signing secrets, service bearers) and requires storage and rotation. The README claim is corrected. | Design D9, README |
| F06 | **Partial.** A versioned task envelope with a `kind` discriminator, eligibility, idempotency key, and fence exists. The full state machine is deferred to `task-state-machine.md`. | Contracts §C5 |
| F07 | **Resolved.** `POST /memories/upsert` and `POST /memories/invalidate` require the administrator principal. The publication job is the intended caller. | Contracts §C3, design §2 |

## High

| # | Disposition | Where |
|---|---|---|
| F08 | **Resolved by restriction.** Phase 1 accepts pre-provisioned static credentials only. OAuth flows are out of scope until a later phase. | Contracts §C2 (scheme list) |
| F09 | **Deferred** to `protocol-contracts.md` (versioned schemas, errors, limits, idempotency). | Deliverable 2 |
| F10 | **Resolved.** Credential stripping on cross-origin redirects, trust-gated private targets, same rules for probes. | Contracts §C2 |
| F11 | **Resolved.** Validate-then-atomic-swap, namespace draining, keep last accepted on failure. | Contracts §C2 |
| F12 | **Deferred** to `protocol-contracts.md` (MCP session features, compatibility tests against stateful upstreams). | Deliverable 2 |
| F13 | **Deferred** to `task-state-machine.md` (ingress acknowledgment, persistence before ack, retry policy). | Deliverable 3 |
| F14 | **Deferred** to `protocol-contracts.md` (replay windows, body limits, rate limits, challenge handling). | Deliverable 2 |
| F15 | **Deferred** to `task-state-machine.md` (states, durations, attempts, cancellation, poison tasks). | Deliverable 3 |
| F16 | **Deferred** to `task-state-machine.md` (expired cursor response, resynchronization, ordering, backpressure). | Deliverable 3 |
| F17 | **Resolved.** Local extractor default. A remote extractor requires `EXTRACTOR_ALLOW_EXTERNAL=1`. | Contracts §C3 |
| F18 | **Deferred** to `protocol-contracts.md` (provenance priority, correction handling, equal confidence, revision trail). | Deliverable 2 |
| F19 | **Deferred, blocking.** Select the Phase 1 embedding provider before implementation. Store model identity and dimension with each collection. | Open question in the design spec |
| F20 | **Deferred** to `protocol-contracts.md` (publication discovery, principal, revision key, atomic replacement). The administrator principal is set (F07). | Deliverable 2 |
| F21 | **Resolved.** Pinned CLI version, pinned `owner/repo@ref` skill entries, explicit `--update`. | Provisioning spec, D13 |
| F22 | **Resolved.** Managed blocks, per-entry hook merges, backups, `--dry-run`, `--restore`. | Provisioning spec |
| F23 | **Resolved.** Secret distribution is out of band (secret manager → `.env.credentials`). Template sync never writes a secret. | Provisioning spec, contracts §C2 |
| F24 | **Resolved by labeling.** The compose block is marked schematic. The implemented file must satisfy D7 and D8 and start with documented inputs. | Design, compose section |

## Medium

| # | Disposition | Where |
|---|---|---|
| F25 | **Resolved.** `/livez` is the shallow check. `/readyz` reports dependency state and returns 503. | Design D8 |
| F26 | **Deferred** to `operations-contract.md` (backup, restore, migration, retention). | Deliverable 4 |
| F27 | **Deferred** to `operations-contract.md` (metric set, structured logs, correlation identifiers). | Deliverable 4 |
| F28 | **Resolved.** Keyed fingerprints (HMAC-SHA256, `LOG_FINGERPRINT_KEY`), or omission. | Contracts §C2 |
| F29 | **Partial.** D13 pins executables and images. Version floors and the model artifact hash go to `operations-contract.md`. | Design D13, deliverable 4 |
| F30 | **Deferred** to `protocol-contracts.md` (canonical test vectors for `projectKey`, SCP-style URLs, ports, aliases). | Deliverable 2 |
| F31 | **Deferred** to `protocol-contracts.md` (every persisted record type and its collection). | Deliverable 2 |
| F32 | **Resolved.** A built-in default policy replaces the silent empty policy. | Contracts §C3 |
| F33 | **Deferred** to `acceptance-matrix.md`. The specs now contain first denial criteria (collaboration criteria 7–9). | Deliverable 6 |

## Low

| # | Disposition | Where |
|---|---|---|
| F34 | **Deferred.** Adopt MUST/SHOULD/MAY during the contract-document pass. | Deliverables 1–4 |
| F35 | **Accepted.** Replace capacity claims with benchmark targets when hardware baselines exist. Until then, read the claims as estimates. | — |
| F36 | **Deferred.** Add a status/owner/version block to each spec during the contract-document pass. | Deliverables 1–4 |

## Pre-Implementation Deliverables

The review requests six documents. They gate implementation and feed the
writing-plans step:

1. `security-model.md` — principals, trust boundaries, registry trust.
   Much of it now exists in the specs. This document consolidates.
2. `protocol-contracts.md` — versioned schemas, errors, limits.
3. `task-state-machine.md` — states, leases, fencing, retries.
4. `operations-contract.md` — readiness, persistence, backup, metrics.
5. `provisioning-safety.md` — covered by the provisioning spec updates.
   Fold remaining detail into that spec.
6. `acceptance-matrix.md` — requirement identifiers and denial tests.

## Findings The Resolutions Push Back On

None rejected. Every finding was either correct or a reasonable request
for missing detail. Two notes:

- F08: the resolution restricts scope instead of adding OAuth. Static
  pre-provisioned credentials match the Phase 1 credential model (D9,
  D10). OAuth arrives with a later phase, if demand exists.
- F35: the capacity numbers stay as estimates until real hardware
  baselines exist. Benchmarks before code would be fiction.
