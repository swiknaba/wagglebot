# Phase 4 — Document Ingestion

> Companion to the [wagglebot design spec](2026-08-28-wagglebot-design.md).
> A human names a document — a Confluence page, an ADR, a runbook —
> and its facts land in a memory scope (D25). This is the last phase
> (D14), and it needs Phase 2, because it writes to the shared store.

## The Pipeline

**Path 2 — document ingestion (D25).** A human names a source. The
extract step is pluggable:

```
ingest_document({ source: "<url>", scope: "domain:payments" })
  → fetch content through an MCP tool
    → extract:  mode "agent"      → the calling agent extracts
                mode "local_llm"  → batch OpenAI-compatible call (D2)
      → [ the same normalize → reconcile → upsert path as above ]
```

The default mode is `agent`, which needs no extra container. The
`local_llm` mode earns its container only at bulk volume. Ingestion
inherits the authorization of its caller: a write to `domain:payments`
still requires membership in the owner group of that Domain (D23).

## Rules That Carry Over

1. **The credential scan runs before the extract step** (D28). A real
   runbook often contains a real credential, so no document content
   reaches a model unscanned. Ingestion is the highest-risk write path.
2. **Authorization inherits from the caller** (D23). A write to
   `domain:payments` requires membership in the owner group of that
   Domain, whoever triggers the ingestion.
3. **The taxonomy validates every fact** (contracts §C3), so an
   ingested memory looks identical to a session memory.

## The Batch Extractor (D2)

The `local_llm` mode uses an OpenAI-compatible HTTP client. Env:
`EXTRACTOR_API_BASE`, `EXTRACTOR_API_KEY` (optional),
`EXTRACTOR_MODEL`. The worker parses each completion defensively. A
non-JSON completion fails the job into the normal retry path.

The compose stack ships the extractor behind the `ingest` profile: a
`llama.cpp` server container with a small Qwen GGUF (~1.1 GB), on a
CPU. A remote endpoint needs only a different `EXTRACTOR_API_BASE`
value. A remote endpoint outside the deployment additionally requires
`EXTRACTOR_ALLOW_EXTERNAL=1` (guards F17).

Start it only for bulk volume:

```
docker compose --profile shared --profile ingest up
```

The default mode is `agent`, which needs no container at all: the
calling agent fetches the page through an MCP tool, extracts the
facts, and writes them through `remember` or `propose_memory`.

## Success Criteria

1. An engineer asks their agent to ingest one page into
   `domain:<name>`. The agent fetches it through an MCP tool, extracts
   facts, and the worker stores them under that scope. The engineer is
   a member of the owner group, or the write is rejected (D23).
2. A page containing an AWS key is scanned before extraction. The key
   never reaches a model, local or remote (D28).
3. With the `ingest` profile up, a batch of pages processes through
   the `local_llm` mode with no agent involved. A non-JSON completion
   retries, and fails cleanly after 3 attempts.
