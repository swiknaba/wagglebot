# Project Brain

The Project Brain combines repository-local memory, current code, Git history,
and reviewed shared facts. The context tools retrieve evidence without saving
chat content. Local memory and CodeGraph stay on the workstation. A shared
request contains only the original natural-language query, catalog scope,
limit, and correlation ID.

## Initialize and update

Run `wagglebot brain init` in a repository to create the local memory bundle
and initialize CodeGraph. The first graph build reads the current checkout;
later updates index changed files. The graph is a local derived index. Check
its freshness before relying on a result, and read current source when it is
pending or stale.

Shared project identity reads the local company catalog from
`WAGGLEBOT_COMPANY_ROOT` when set, or from `~/.wagglebot/company/active` when
that cached checkout exists. Set `WAGGLEBOT_COMPANY_ROOT` to a company
repository checkout to use it directly. The context engine rereads the catalog
for each identity check and does not fetch or refresh company data. Without a
catalog, local identity remains available but shared scopes cannot be resolved.

The authoritative memory concepts live under `.agents/memory/`. Edit the
relevant concept file and run `wagglebot update` to validate it and regenerate
the indexes. Keep one durable concept in each file. Do not store chat
transcripts, credentials, or temporary task state.

## Retrieve context

Use `brain_wake` at L0 for a new chat. L0 is local-only, returns no retrieved
items, and is capped at 150 estimated tokens. Use L1 only when the developer
asks to continue or requests orientation. L1 is capped at 500 tokens and can
include up to three reviewed shared wake facts within a 200-token shared
budget. Use L2 when the developer gives a concrete task. Use `brain_search`
for a focused question and `brain_explain` for code relationships or history.
L2 and search return at most six items, including at most three shared items,
within 1,500 estimated tokens. `brain_status` reports provider health without
retrieved prose.

Pass the latest context cursor to later retrieval calls. The process keeps
only item IDs and content hashes for four hours. Unchanged items are
suppressed; changed items can return. Follow evidence references when you need
details. Each response uses one prose representation: Markdown text by default
or structured content when requested. Shared-provider failure degrades the
packet while healthy local providers continue.

## Save durable memory

When the developer explicitly asks to remember a durable fact, use
`brain_memory_propose` to preview the concept and its Markdown diff. Save the
approved proposal with `brain_memory_save`. An agent-originated suggestion
stays a proposal until the developer promotes it. The workflow saves the
distilled fact and evidence, not the chat that produced it.

## Context Bridge

Wake is a small project orientation regenerated for a chat. Context Bridge is
an explicit export and import by opaque handle. Project scope is the default;
workstation scope is an explicit opt-in. Bridge packets expire, stay in the
local protected vault, and are not durable memory or transcripts. Imported
context is labeled. Check its evidence and freshness, then use the existing
memory proposal/save flow if a fact should become durable. Wake never searches
the Bridge vault or imports a packet.

## Evidence and shared facts

Shared memory contains reviewed system, domain, and organization knowledge.
Automatic wake includes only active, high-confidence, unexpired facts marked
for wake. Context retrieval never writes local or shared memory. Search sends
the original clipped natural-language query and catalog scopes to the shared
service; it does not send local memory, code, Git state, paths, or transcripts.
Use `brain_status` to inspect local and shared provider state. Admins can
queue and drain shared-memory reindex work with `wagglebot memory admin
reindex` and `wagglebot memory admin run-once`. These commands do not rebuild
the local CodeGraph index.
