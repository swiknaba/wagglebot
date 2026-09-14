# Phase 4 — Ingestion Workers

## Scope

- Require the [Phase 2 shared layer](2026-08-28-phase-2-shared-layer.md).
- Ship a background worker runner and a `workers/` folder for user scripts.
- Treat each source as a separate knowledge base when the operator requires isolation.
- Use the same PostgreSQL database and embedding service as shared memory.
- Generate embeddings with `all-MiniLM-L6-v2` on the CPU, as specified in Contract C3.
- Require no GPU or external model API for ingestion and search.
- Keep source connectors outside Wagglebot.
- Exclude built-in Confluence clients, crawlers, model servers, and workflow editors.
- Keep source code graphs outside this phase.

## Responsibilities

| Owner | Responsibility |
|---|---|
| Wagglebot | Load scripts, execute jobs, enforce timeouts, retry failures, and retain job status |
| Wagglebot | Validate records, scan for secrets, create embeddings, and store records |
| User script | Fetch content, manage source credentials, parse content, and divide documents into sections |
| User script | Select useful content, supply metadata, and detect source changes or deletions |
| Operator | Configure each worker, its target knowledge base, and its execution interval |

- Accept plain text sections or structured facts.
- Do not require an LLM to import documents.
- Let user scripts summarize content when necessary.
- Provide the credential scanner to scripts before any optional model call.
- Require scripts to call that helper themselves. The runner cannot enforce scans on arbitrary external requests.
- Scan text and metadata again at the ingestion API.
- Keep existing fact validation and publication rules for fact submissions.

## Knowledge Bases

- Require `knowledge_base_id` on every shared record.
- Declare knowledge bases in deployment configuration.
- Support team, organization, and source bases through the same table and API.
- Use stable IDs, such as `team-payments`, `organization`, and `confluence`.
- Require one target base for each worker.
- Reject missing or unknown base IDs.
- Keep catalog scopes within each base.
- Let workers configure catalog scopes for document records.
- Permit empty scopes for source documents. A base-only search must include these records.
- Apply catalog scope filters only when the request selects those scopes.
- Preserve required catalog scopes for fact submissions.
- Do not infer a base from a source URL or a team name.
- Treat isolation as an API query boundary, not separate user authentication.

| Operation | Rule |
|---|---|
| Search and record queries | Require a base ID and apply it before ranking, limits, and pagination |
| Upsert | Match the base ID and stable source record ID |
| Invalidation | Require the base ID and stable source record ID |
| Deduplication and replacement | Compare records within the same base only |
| Agent memory | Resolve the base from explicit configuration and preserve existing catalog authorization |
| Global admin overview | Aggregate counts across bases without content access |

- Keep records from other bases outside each operation.
- Reject attempts to select another base through a worker payload.
- Do not add an implicit search across all bases.
- Keep repository-local component memory unchanged.

## Record Metadata

Extend `wagglebot_memories` through the required Sequel migrations.

| Column | Requirement |
|---|---|
| `knowledge_base_id text NOT NULL` | Configured knowledge base ID |
| `record_type text NOT NULL` | `fact` or `document` |
| `metadata jsonb NOT NULL DEFAULT '{}'::jsonb` | Source metadata object |
| `canonical_key text NOT NULL` | Fact key or stable document section key |

- Require unique `(knowledge_base_id, canonical_key)` values.
- Add a database constraint for the permitted `record_type` values.
- Include the base ID in new record ID hashes.
- Add an index on `knowledge_base_id`.
- Keep document text in `text` and its embedding in `embedding`.
- Reserve `kind` and fact reconciliation rules for `record_type=fact`.
- Do not parse document sections as fact records.
- Do not apply fact confidence rules to document replacement.

Suggested metadata:

| Key | Value |
|---|---|
| `source` | Connector name, such as `confluence` |
| `source_id` | Stable source record ID, including the section ID when necessary |
| `document_id` | Stable parent document ID |
| `url` | Source URL without credentials |
| `title` | Source title |
| `section` | Section name or identifier |
| `source_updated_at` | Source modification time |

- Use the existing `content_hash` column for the hash of accepted text and metadata.
- Calculate that hash on the server with stable JSON key order.
- Let scripts add JSON metadata fields.
- Reject secrets in metadata.
- Set request size limits for text and metadata.
- Keep credentials in worker environment variables or mounted secret files.
- Exclude record metadata from the admin API, except explicitly defined aggregate fields.

Migration requirements:

- Add the columns, constraints, and indexes through versioned `up` and `down` migrations.
- Update the release migration manifest and schema dump.
- For existing rows, require an explicit base mapping before the migration.
- Stop if the mapping omits a record or creates duplicate keys within a base.
- Preserve existing record IDs and references during the migration.
- Mark existing memory records as `fact` and initialize metadata to `{}`.
- Reject rollback if document records or keys across multiple bases prevent restoration of the previous schema.

## Worker Interface

Example deployment configuration:

```yaml
knowledge_bases:
  - id: confluence

workers:
  - id: confluence-import
    script: workers/confluence.ts
    knowledge_base_id: confluence
    interval_seconds: 3600
    timeout_seconds: 900
```

Example user script:

```typescript
export async function run(context) {
  // The operator implements this source client.
  for (const section of await readChangedSections()) {
    await context.knowledge.upsert({
      sourceId: `${section.documentId}:${section.id}`,
      text: section.text,
      metadata: {
        document_id: section.documentId,
        title: section.title,
        url: section.url,
      },
    });
  }

  for (const sourceId of await readDeletedSections()) {
    await context.knowledge.invalidate({ sourceId });
  }
}
```

- Bind `context.knowledge` to the configured base and worker ID.
- Derive each document key from `document`, the worker ID, and `sourceId` with unambiguous encoding.
- Set `record_type=document` for this interface.
- Set source identity metadata from the bound context and `sourceId`.
- Reject conflicting identity metadata.
- Send accepted records to the memory service through the common ingestion API.
- Configure the worker service credential on the server.
- Validate the worker identity and configured base at that API.
- Reuse the common scan, embedding, and storage path.
- Replace text, metadata, and embedding together when a record changes.
- Reactivate an inactive record when its source submits it again.
- Skip embedding work when accepted text does not change.
- Make repeated upserts and invalidations safe after a retry.
- Invalidate records through the existing inactive record fields.
- Let scripts invalidate obsolete sections after document changes.
- Do not treat a failed fetch or an incomplete source scan as a deletion.

## Job Execution

- Reuse the existing filesystem queue rules from [Contract C3](2026-08-28-service-contracts.md#c3-memory-worker-contract-phase-2-component-memory-is-a-phase-1-local-file-d29).
- Use a separate ingestion queue and runner so imports do not block session proposals.
- Ship the runner image from `services/ingestion-worker`.
- Declare its `ingestion-worker` compose service under the `ingest` profile.
- Let operators extend that image for connector dependencies and configure its image through a compose override.
- Mount `workers/` read-only and persist the queue on a volume.
- Run each job in a child process.
- Process one ingestion job at a time for the MVP.
- Accept interval triggers and an explicit CLI trigger.
- Do not queue another interval job while that worker has a queued or active job.
- Persist the next attempt number before each process start.
- Terminate the child process and its descendants when its configured timeout expires.
- Stop child processes when the runner stops. Confirm termination before a retry.
- Retry failed or interrupted jobs up to three total attempts.
- Wait 30 seconds before each retry.
- After runner restart, retry unfinished jobs within the remaining attempt limit.
- Record job ID, worker ID, base ID, state, attempts, timestamps, and a fixed error code.
- Exclude source text, credentials, and raw errors from job status.
- Keep connector dependencies in the user worker image.
- Do not add Redis or a separate workflow service.

## Admin Integration

- Keep the dashboard usable without Phase 4.
- Include source bases in knowledge counts and global totals.
- Filter counts by base ID before any catalog scope filter.
- Show counts and status only.
- Exclude document titles, text, URLs, metadata objects, and embeddings.

## Verification

1. Import two records with the same source ID into different bases. Confirm that both remain separate.
2. Search one base. Confirm that the response contains no records from another base.
3. Repeat an upsert. Confirm that the record count does not increase.
4. Change a section. Confirm that its text, metadata, and embedding agree after the update.
5. Invalidate a section. Confirm that normal search excludes it and preserves the other base.
6. Terminate a job after one successful upsert. Confirm that a retry creates no duplicate record.
7. Exceed the job timeout. Confirm termination and failure after three attempts.
8. Reject an unknown base, invalid metadata, and credentials in text or metadata.
9. Confirm that the admin API returns counts without source content or metadata objects.
10. Run migration checks against an existing database. Confirm explicit base assignment and preservation of unrelated tables.
