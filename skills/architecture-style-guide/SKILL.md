---
name: architecture-style-guide
description: Use when designing a component or reviewing changes to public names, business boundaries, abstractions, or framework integration.
---

# Architecture and Style Guide

## Overview

Use the project's language and framework idiomatically. Apply the universal
principles below; treat language and framework conventions as local choices.
Existing repository instructions and established conventions take precedence
over this guide when they conflict. Flag a consequential conflict in the result.
Do not create layers merely to match a familiar architecture.

## Core rules

- Choose domain boundaries around product or business capabilities and their
  rules. Name the need served, responsibility owned, and invariants protected.
  `Orders` and `Returns` can own different rules; `Database` and `Services` are
  technical categories, not business domains. Label technical infrastructure
  honestly. Keep related behavior together until a separate boundary earns its
  cost; domain folders and extra layers are optional.
- Name public concepts after their meaning and responsibility, using the
  language and framework's conventions. Prefer `ApproveReturn` to `Manager` or
  an unexplained metaphor. A component README must explain whose need it serves,
  the user outcome it enables, and why it is separate. Put technology lists in
  setup or implementation documentation.
- Give each unit one coherent responsibility. Do not turn a controller or
  namespace into a container for unrelated request, value, error, or transport
  types.
- Reuse framework models, queries, validation, serialization, transactions,
  and lifecycle tools. Add a wrapper only when it owns a domain rule, safety
  boundary, invariant, lifecycle, or simpler intentional API.
- Translate raw transport, storage, and vendor data at boundaries.
  Workflow or use-case code orchestrates and may use framework models;
  decision code takes values, returns outcomes, and imports no transport or storage modules.
  Decision code must also avoid vendor modules. Adapters depend on the domain
  contracts they implement. Connect them through existing framework composition
  points. Cross-domain calls use named public operations and precise inputs and
  outcomes; do not read another domain's tables or internal models. Do not add
  layers that only forward calls.
- Make relevant state transitions, idempotency, ordering, and uncertain side
  effects visible.
- Represent expected outcomes that callers branch on with the language's
  idiomatic result or error mechanism. Distinguish them from programmer errors
  and infrastructure failures. Preserve failure causes and useful context without
  exposing secrets or personal data. Translate failures where the caller can
  decide how to respond. Do not disguise a bug or an uncertain external action
  as an ordinary business rejection.
- Follow repository file and module conventions. Keep distinct concrete types
  in distinct files where the ecosystem expects it; group closely related
  functions or types in module-oriented languages when that is clearer.

## Before design and coding

Read repository instructions, framework documentation, relevant examples, and
the APIs supported by the installed version before proposing an implementation.
For an unfamiliar framework, trace an existing example through those APIs.
Map each proposed capability to a supported feature and cite the local example
or API that demonstrates it. Include persistence, queries, row resolution,
serialization of JSON fields, transactions, and lifecycle hooks where relevant.

Use those features directly. For any raw database access, custom row mapper,
serializer, query helper, or framework wrapper, identify the specific capability
gap and explain why the supported API cannot express it. Keep exceptions narrow.
If support is unverified, mark the design decision unresolved and inspect the
API further before implementing a replacement.

State the component's purpose, its boundary, the framework abstractions to
reuse, and the behavior that proves the change. Identify state transitions,
idempotency, and external effects when they matter. Keep the first design local
unless a real cross-component contract is needed.

Create an abstraction only when it names a stable domain concept, protects a
real dependency boundary or unsafe input, owns a lifecycle, invariant, or side
effect, simplifies several callers intentionally, or makes a real behavior or
dependency boundary easier to test.

Keep code local otherwise. Do not add a generic service, repository, DTO, or
wrapper solely for familiar structure or to make implementation calls mockable.

Ask: "What would become harder or less safe if this disappeared?" If the answer
is only that the architecture would look less familiar, do not add it.

## Examples

Keep request translation, domain decisions, and effects distinct:

```text
PostMessageHandler.handle(request):
  command = PostMessageRequest.validate(request)
  outcome = MessageDelivery.deliver(command)
  return Response.from(outcome)

MessageDelivery.deliver(command):
  persist idempotent delivery intent in the caller's transaction
  dispatch it after commit
  return Queued or a precise rejection
```

Use framework model and query APIs before creating manual SQL, row mapping, or
serialization. Create a response type only when it protects a real public
contract, hides internal data, or represents a different public concept.

After request validation, name the domain outcomes that the caller handles:

```text
start_review(validated_request) -> Started | AlreadyStarted | RevisionChanged
```

## Review prompts

- Does each proposed domain own a business capability and its invariants, and
  does its README explain the user need and reason for separation?
- Does each new abstraction own a real concept, boundary, invariant, lifecycle,
  simpler API, or behavior?
- Which documented framework features replace custom persistence, mapping,
  serialization, or lifecycle code? Inspect the implementation against the
  supported API; require a specific gap for each remaining workaround.
- Are raw external values contained at boundaries, and do imports follow the
  intended dependency direction? Do cross-domain calls use public contracts?

A passing type check or test suite does not establish suitable names, boundaries,
or framework reuse. Review those design choices directly.

## Output

For design, return a short proposal stating purpose, responsibilities, dependency
direction, cross-domain contracts, and why any new abstraction is needed. Include
the capability-to-framework mapping with evidence, justified exceptions, observable
acceptance behavior, and any decision that remains open. Produce this before
implementation; keep its size proportional to the change.

For review, report actionable findings with file locations, the concrete impact,
and the smallest useful correction. If there are no findings, say so. Identify
unverified assumptions separately from demonstrated problems. State which
business boundaries and framework APIs you inspected; a review based only on
types or tests is incomplete. Compare the actual names, imports, persistence,
and public contracts against the design decisions and framework mapping.
