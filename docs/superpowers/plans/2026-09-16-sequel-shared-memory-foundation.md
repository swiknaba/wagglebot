# Sequel Shared Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the shared-memory persistence foundation with safe Ruby/Sequel migrations and a TypeScript/Bun worker that embeds records locally on CPU.

**Architecture:** `services/database` is a short-lived Ruby 3/Sequel image; it is the only process that changes schema and it exits after its named command. `services/memory-worker` remains the public application service, validates facts, produces 384-dimensional `all-MiniLM-L6-v2` vectors in process, and reads/writes the one `wagglebot_memories` table through parameterized PostgreSQL queries. Phase 4 extends that table in a later Sequel migration; it does not create a parallel document store.

**Tech Stack:** Ruby 3, Rake, Sequel, `pg`, PostgreSQL with pgvector, TypeScript, Bun, `pg`, `@xenova/transformers` using CPU ONNX Runtime.

**Spec:** `docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md`, `docs/superpowers/specs/2026-08-28-service-contracts.md`, and `docs/superpowers/specs/2026-08-28-phase-4-document-ingestion.md`.

## Global Constraints

- The Ruby commands follow the small explicit task-wrapper style used by Ludwig's Kirei test application; Kirei is a reference for task shape, not an application runtime dependency.
- Keep Ruby out of application containers. The migration image is separate and executes one named command against one `DATABASE_URL`.
- Do not add database create/drop commands or auto-select environments. Stop before connecting when `DATABASE_URL` is empty.
- Use Sequel migration history table `wagglebot_schema_migrations` and `use_advisory_lock: true`.
- Preserve unrelated PostgreSQL objects and the shared `vector` extension. Maintain an explicit Wagglebot object list.
- The Phase 2 schema has exactly `wagglebot_memories`, `wagglebot_memory_schema_metadata`, and `wagglebot_schema_migrations`; no MemPalace, outbox, or normalized memory tables.
- The worker embeds with `@xenova/transformers`, model `all-MiniLM-L6-v2`, dimension `384`, cosine distance, on CPU. Metadata mismatch aborts worker startup.
- Parameterize all SQL. Do not log DSNs, memory text, queries, credentials, provenance content, or embeddings.
- Component memory remains `.agents/memory.md`; it must not enter shared storage. Phase 4 requires `knowledge_base_id` for all reads and writes.

---

## File Map

```text
services/database/
  Gemfile                     # fixed Ruby dependencies
  Rakefile                    # db:generate/migrate/rollback/status/check/schema:dump tasks
  Dockerfile                  # isolated Ruby migration image
  lib/database.rb             # environment validation, Sequel connection, manifest helpers
  lib/tasks/db.rake           # task definitions and explicit command parsing
  db/migrations/*.rb          # timestamped reversible migrations
  migration-version.json      # committed ordered migration manifest
  schema.sql                  # committed pg_dump schema reference
  test/database_test.rb       # pure manifest/config/task-boundary tests
services/memory-worker/
  package.json                # CPU embedding dependency and service scripts
  src/config.ts               # database and supported embedding configuration
  src/embeddings.ts           # lazy singleton CPU embedding adapter
  src/repository.ts           # parameterized memory reads/writes and metadata check
  src/index.ts                # readiness gate before accepting work
  src/*.test.ts               # observable validation, metadata, and query tests
deploy/
  env.example                 # database and embedding configuration only
```

### Task 1: Create the isolated Sequel command service

**Files:** Create `services/database/Gemfile`, `Rakefile`, `lib/database.rb`, `lib/tasks/db.rake`, `Dockerfile`, `test/database_test.rb`; modify `deploy/env.example`.

**Interfaces:** Produces `Database.connection!`, `Database.expected_manifest`, and Rake tasks `db:generate[description]`, `db:migrate`, `db:rollback[version]`, `db:status`, `db:check`, and `db:schema:dump`. `connection!` accepts only `DATABASE_URL`; it raises `DATABASE_URL is required` before loading Sequel when unset.

- [ ] Write tests that call `Database.expected_manifest` with a temporary migration directory, reject an empty `DATABASE_URL`, and reject `db:rollback` without a numeric target version.
- [ ] Run `bundle exec ruby -Ilib test/database_test.rb`; confirm the new test first fails because `Database` is absent.
- [ ] Add fixed `sequel`, `pg`, and `rake` dependencies; use a Ruby 3 image because the supported Kirei release requires Ruby 3 or newer, while application services remain Bun.
- [ ] Implement `Database.connection!` with `Sequel.connect(ENV.fetch("DATABASE_URL"), max_connections: 1)` only after non-empty validation, and keep the URL out of exceptions and output.
- [ ] Implement all six Rake task names. `db:rollback[version]` must require `/\A\d{14}\z/`; each migration invocation uses `Sequel::Migrator.run(db, migration_dir, table: :wagglebot_schema_migrations, use_advisory_lock: true)`.
- [ ] Run the Ruby tests and `bundle exec rake -T`; verify all six commands are listed and an empty `DATABASE_URL` exits before a connection.
- [ ] Commit as `feat(database): add isolated Sequel migration commands`.

### Task 2: Add the Phase 2 schema and deterministic release checks

**Files:** Create `services/database/db/migrations/<timestamp>_create_memory_schema.rb`, `migration-version.json`, `schema.sql`, `test/migration_manifest_test.rb`; modify `lib/database.rb`, `lib/tasks/db.rake`.

**Interfaces:** `Database.expected_manifest` returns `{ "latest": String, "migrations": String[] }`. `db:check` compares the complete ordered list in the database against that manifest and returns nonzero for missing or unexpected versions. The migration creates `wagglebot_memories` and `wagglebot_memory_schema_metadata` only.

- [ ] Write manifest tests for reordered, missing, and unexpected versions; add migration-shape tests that require `up` and `down`, `embedding vector(384)`, a cosine HNSW index, and unique `canonical_key`.
- [ ] Run the focused Ruby tests and confirm the schema assertions fail before adding the migration.
- [ ] Add a reversible Sequel migration which verifies `vector` and cosine operators, creates exactly the specified tables, records embedding metadata `{ provider: "xenova-transformers", model: "all-MiniLM-L6-v2", dimension: 384, distance: "cosine", schemaVersion: 1 }`, and creates GIN (`scopes`) and HNSW (`embedding vector_cosine_ops`) indexes.
- [ ] Generate and commit the manifest from sorted migration filenames. Implement `db:check` as read-only and make `db:migrate` run it after migration.
- [ ] Add `services/database/init-vector.sql` only for the optional local PostgreSQL image; keep extension installation out of the migration's rollback.
- [ ] Use `pg_dump --schema-only --no-owner --no-privileges` with the explicit object list to generate `schema.sql`; verify a fresh pgvector database can apply migration, pass `db:check`, and match the dump.
- [ ] Commit as `feat(database): add versioned shared-memory schema`.

### Task 3: Add CPU embedding and worker readiness gates

**Files:** Modify `services/memory-worker/package.json`; create `src/config.ts`, `src/embeddings.ts`, `src/repository.ts`, `src/index.ts`, and focused tests.

**Interfaces:** `EmbeddingProvider.embed(text: string): Promise<number[]>`; `MemoryRepository.assertReady(): Promise<void>`; `MemoryRepository.upsert(record, embedding): Promise<void>`. `embed` returns exactly 384 finite values. `assertReady` compares the database metadata to the fixed profile before the HTTP listener starts.

- [ ] Write failing Bun tests for a non-384 vector, embedding-profile mismatch, and startup refusing to listen before `assertReady` resolves.
- [ ] Add exact `@xenova/transformers` dependency and a CPU-only adapter; pool and normalize the model output before checking its length and finite values.
- [ ] Implement the repository with `$1`-style parameters, `vector` cast parameters, and a metadata query that names the required re-embedding action on mismatch without logging records.
- [ ] Make `/readyz` return `503` until migration and metadata checks pass, while `/livez` remains shallow.
- [ ] Run focused Bun tests, `bun run check`, and `bun run typecheck`; add an integration test against pgvector when the container is available.
- [ ] Commit as `feat(memory): embed records locally on CPU`.

### Task 4: Implement Phase 2 fact persistence and retrieval

**Files:** Create `services/memory-worker/src/canonicalize.ts`, `src/write-service.ts`, `src/search-service.ts`, HTTP/MCP route files and tests; modify `packages/contracts` only when its API contract is inconsistent with C3.

**Interfaces:** `WriteService.remember(input, principal)` and `SearchService.search(input, principal)` use the existing `MemoryProvider` seam. Searches filter scopes before vector ranking, use `<=>`, calculate `1 / (1 + distance)`, default `minScore` to `0.35`, and exclude inactive records.

- [ ] Write failing tests for component-scope rejection, secret-scan rejection before SQL execution, canonical-key idempotency, supersession, invalidation, and scope filtering before result limit.
- [ ] Implement fact-only writes to the single table, preserving JSON provenance, lifecycle columns, and operation-key semantics without introducing side tables.
- [ ] Implement cosine search and wake search using only the table; prove inactive and below-threshold records are absent.
- [ ] Expose the C3 HTTP and MCP operations through the existing D26 principal verification, with bounded request/response schemas and safe error envelopes.
- [ ] Run focused service tests, complete workspace check/typecheck/build, and PostgreSQL integration tests.
- [ ] Commit as `feat(memory): serve shared facts from PostgreSQL`.

### Task 5: Deliver the Phase 4 table extension and ingestion boundary

**Files:** Add a Sequel migration, update manifest/schema/tests, then create only the worker runner files specified by the Phase 4 spec.

**Interfaces:** The migration adds `knowledge_base_id`, `record_type`, and `metadata`; replaces unique `canonical_key` with unique `(knowledge_base_id, canonical_key)`; all public `MemoryProvider` inputs include `knowledgeBaseId` with no default.

- [ ] Write migration tests covering required explicit mapping for old rows, duplicate detection within a mapped base, document rollback refusal, and no cross-base read/write leakage.
- [ ] Add the reversible guarded migration and release artifacts. It must mark old records as `fact`, metadata `{}`, and preserve record IDs.
- [ ] Implement the separate one-at-a-time ingestion runner and its user-owned `workers/` interface, enforcing configured worker/base identity, retry limits, timeout cleanup, and content-free job status.
- [ ] Add cross-base upsert/search/invalidation tests and no-duplicate retry coverage.
- [ ] Run all worker/migration tests plus the broader repository gates, then commit as `feat(ingestion): add knowledge-base isolation`.

## Review Checklist

- The obsolete plans named above are marked historical and no active implementation document requires MemPalace, an outbox, normalized memory tables, or TypeScript migrations.
- The migration service owns schema changes, has no create/drop task, and never outputs a database URL.
- The only Phase 2 memory data tables are the two documented tables plus Sequel history.
- The embedding metadata, model, dimension, and cosine distance match exactly in migration, worker configuration, and readiness tests.
- Phase 4 changes the existing table instead of introducing a second record store.
