# Deployment configuration

The repository currently provides individual Dockerfiles for the database
migration service, auth service, and registry service. It does not yet provide
a Compose file or a complete runnable Phase 2 stack; the MCP hub server and
memory worker remain unfinished.

Copy `env.example` to the environment file used by your container runtime and
replace every example value before deployment. Pass each container only the
block it reads:

| Configuration block | Container or service | Status |
| --- | --- | --- |
| `DATABASE_URL` | `services/database` migration container | Implemented |
| `AUTH_*` | `services/auth` | Implemented; exposes port 8080 |
| `REGISTRY_*` | `services/registry` | Implemented; exposes port 3040 |
| `MEMORY_*` | `services/memory-worker` | Not built; variables remain commented out |

The auth and registry issuer values must match. Mount the signing private key
only into the auth container and mount its corresponding public key into the
registry container. PostgreSQL must have the `vector` extension before running
the database migration service.
