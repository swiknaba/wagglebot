---
name: architecture-style-guide
description: Use when designing a component or reviewing changes to public names, business boundaries, abstractions, or framework integration.
---

# Architecture and Style Guide

## Overview

Repository instructions and established conventions take precedence over this
guide. Flag consequential conflicts. Use the language and framework idiomatically.

## Before implementation

Read framework documentation, examples, and the installed version's APIs before
designing around them. For an unfamiliar framework, trace a relevant example.
Map proposed functionality to supported features; name the relevant API or example.

Use the framework's ORM, query, transaction, validation, and serialization
facilities where applicable. Low-level access or custom replacements require a
demonstrated capability gap; document it and keep the exception narrow.
Unverified support is an unresolved design decision, not permission to rebuild.

## Design rules

- Define domains by product capabilities and invariants. `Orders` and `Returns`
  can own different rules; `Database` and `Services` are technical categories.
  Keep related behavior together until separation has a concrete benefit.
- Use meaningful domain names and idiomatic file or module organization.
  Explain unusual public terms. For an independently navigable component, a short
  README states whose need it serves, the user outcome, and why it is separate.
  Put technology lists elsewhere.
- Give each unit a coherent responsibility. Keep unrelated request, value, error,
  and transport types out of controller namespaces.
- Workflow code orchestrates and may use framework models. Decision code takes
  values and returns outcomes without importing transport, storage, or vendor
  modules. Adapters depend on domain contracts. Cross-domain calls use explicit
  public operations, not another domain's tables or internal models.
  These responsibilities need no separate layers when local functions suffice.
- Add an abstraction only for a domain concept, invariant, lifecycle, boundary,
  or materially simpler API. Ask what becomes harder or less safe without it.
  Keep code local otherwise; avoid forwarding wrappers and mock-only layers.
- Make state transitions, ordering, idempotency, and uncertain effects explicit.
  Represent expected outcomes through idiomatic results or errors. Distinguish
  programmer errors and infrastructure failures; preserve useful causes and
  context without exposing secrets or personal data.

## Example

A handler validates a request and delegates a command. The workflow records
delivery intent transactionally; delivery occurs after commit. Decision code
returns outcomes such as `Queued` or `NotAllowed`. A network timeout remains
uncertain until reconciled.

## Output and verification

Before coding, give a brief design: purpose, responsibilities, dependency
direction, public contracts, framework mapping, justified exceptions, and
observable acceptance behavior. Identify unresolved decisions.

For review, compare actual names, imports, persistence, and contracts with that
design and the supported framework APIs. Report actionable findings with file
locations, impact, and the smallest useful correction. State what you inspected
and what remains unverified; say when there are no findings.

Run applicable whole-project type checks and tests of observable behavior and
relevant failure paths. Passing checks alone do not validate architectural choices.
