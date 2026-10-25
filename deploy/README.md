# Deployment configuration

The MCP hub is a local workstation service. Run it natively with
`bun run --filter @wagglebot/mcp-hub start`; do not put its hub bearer token,
upstream credentials, or local trust store into a shared Compose profile.
For local registry mode, provide a generated `MCP_HUB_BEARER_TOKEN` of at least
32 characters, an absolute `MCP_HUB_CONFIG_PATH` to a JSON `RegistrySnapshot`
with mode `0600`, and a local `MCP_HUB_TRUST_PATH` (defaults under the current
user's home). Bind with `MCP_HUB_HOST=127.0.0.1`. Approve each namespace from
the same local snapshot by setting `MCP_HUB_CONFIG_PATH` and running
`wagglebot mcp-hub approve <namespace>`; the command prompts for confirmation.
For remote mode, set `MCP_HUB_CONFIG_URL` to the registry's HTTPS `/registry`
endpoint and configure `MCP_HUB_AUTH_URL` (HTTPS), `MCP_HUB_AUTH_USERNAME`, and
`MCP_HUB_AUTH_PUBLIC_KEY_FILE`; the auth client signs through the local SSH
agent (`SSH_AUTH_SOCK` must be available). To approve a remote entry, place the
reviewed registry snapshot in a protected local JSON file and point
`MCP_HUB_CONFIG_PATH` at it for the CLI command. The snapshot contains no auth
token. The hub's `/livez` and `/readyz` endpoints support local health checks.

For the local Phase 2 Compose stack, follow the [Phase 2 deployment guide](./phase2.md).
It starts PostgreSQL, migrations, auth, registry, the memory worker, and a
loopback-only HTTPS gateway. The MCP hub and context engine remain native
workstation services.

The Compose guide creates a protected `.env` for its fixture. For manual
service configuration, use `env.example` as a reference and pass each service
only the block it reads:

| Configuration block | Container or service | Status |
| --- | --- | --- |
| `DATABASE_URL` | `services/database` migration container | Implemented |
| `AUTH_*` | `services/auth` | Implemented; internal listener on 8080 |
| `REGISTRY_*` | `services/registry` | Implemented; internal listener on 3040 |
| `MEMORY_*` | `services/memory-worker` | Implemented; internal listener on 3050 |
| `MCP_HUB_*` and `MCP_HUB_AUTH_*` | Local workstation MCP hub | Implemented; configure outside shared Compose |

For a manually configured deployment, the auth and registry issuer values must
match. Mount the signing private key only into the auth container and mount its
corresponding public key into the registry container. PostgreSQL must have the
`vector` extension before running the database migration service.

For a manually configured memory worker, mount the company checkout, SPKI
public key, pinned Gitleaks binary and writable model cache at the absolute
paths configured by `MEMORY_COMPANY_ROOT`, `MEMORY_SESSION_TOKEN_PUBLIC_KEY_FILE`,
`MEMORY_GITLEAKS_EXECUTABLE` and `MEMORY_MODEL_CACHE_DIR`. Set
`MEMORY_ADMIN_BEARER_TOKEN` to an operator-managed secret and mount the JSON
repository-identity-to-absolute-checkout map named by
`MEMORY_PUBLICATION_REPOSITORIES_FILE`; the worker accepts local checkouts only
and validates them before opening its listener. The configured token protects
publication and admin HTTP routes independently from signed session tokens.
The worker validates its database, current catalog, scanner pin and embedding
model at startup. Its `/readyz` response reports database, catalog, scanner,
embedding, verification-key and publication-checkout readiness without
exposing paths or raw errors.

## Scoped database backup and restore (unreleased Phase 2)

Run these native operator tasks from a complete repository checkout with Bun,
Ruby/Bundler and installed workspace/gem dependencies. The migration image
does not include Bun or the validator and remains dedicated to migrations.
Use the existing `DATABASE_URL` environment to select one database.

```sh
cd services/database
bundle exec rake 'db:backup[/protected/wagglebot-snapshot.json]'
```

Backup reads a consistent database snapshot and creates a new file with mode
`0600`; existing files and symlinks are rejected. Treat it as sensitive data.
It contains only the three Wagglebot application tables, the ordered migration
manifest and fixed embedding profile. It preserves audit history, vectors,
source state, operation results, pending work and claim/run descriptors.
It contains JSON data, not SQL or a `pg_restore` archive. Schema-reference
export remains the separate `db:schema:dump` task.

Before restoring, **stop every memory worker and administrative queue drain**,
including work still scanning or embedding. Keep them stopped until restore
finishes, then start fresh processes. Database locks serialize the replacement
transaction; they cannot cancel work prepared before a restore or fence a
process holding a claim that the snapshot restores.

The target must already have exactly the shipped migrations and embedding
profile; restore does not migrate or create database objects. Configure the
same pinned scanner boundary as the worker using
`MEMORY_GITLEAKS_EXECUTABLE` and `MEMORY_GITLEAKS_SHA256` (Gitleaks 8.30.1).

```sh
bundle exec rake 'db:restore[/protected/wagglebot-snapshot.json]'
```

The fixed Bun validator receives the snapshot bytes on stdin. It validates the
entire strict format, then scans persisted record and coordination material in
bounded units with the built-in scanner and pinned Gitleaks before any data
replacement. Missing validators/scanners or rejected strings fail closed.
Newer scanner rules may reject historical invalidated audit rows; review and
explicitly redact a replacement snapshot rather than bypassing scanning or
silently omitting history. Backup validates structure without rescanning the
existing data; restore always requires scanning.

Restore replaces only memories and singleton metadata in one transaction,
retaining the already matching migration history. It preserves unrelated
tables, roles, extensions and the database/schema. Invalid archives, target
mismatches or SQL insertion failures leave prior data intact. Tasks print only
counts and safe errors. There are no backup/restore HTTP or MCP endpoints.
