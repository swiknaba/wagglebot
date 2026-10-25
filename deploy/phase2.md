# Local Phase 2 Compose stack

This guide starts the shared memory services on a developer workstation. The
stack contains PostgreSQL, its Ruby/Sequel migration job, auth, registry, the
memory worker, and Caddy. Caddy publishes HTTPS only on `127.0.0.1`. PostgreSQL
TLS is verified by both the migrator and worker.

The MCP hub and context engine stay native on the workstation. The hub keeps
its local bearer token, trust store, SSH agent access, and upstream credentials
outside Compose. The migration image remains Ruby-only; the existing backup
and restore operator path runs natively with Bun, Ruby/Bundler, and the pinned
Gitleaks scanner.

The initializer creates a disposable fixture company, three fixture repositories,
TLS certificates, an SSH identity, and secrets under a new state directory.
Use this flow for local integration and disposable test fixtures, not as a
substitute for provisioning production identity or company data.

## Requirements

- Bun and the repository dependencies installed with `bun install --frozen-lockfile`.
- Git, OpenSSH (`ssh-keygen`), and OpenSSL on the host.
- A local Docker-compatible engine reachable through the inherited `DOCKER_HOST`
  or the Docker CLI's normal default socket.
- Either the Docker Compose CLI plugin (`docker compose`) or the standalone
  `docker-compose` command.

The initializer detects Homebrew Docker CLI plugin directories and records
them in an isolated Docker client configuration. Set `DOCKER_CONFIG` to that
directory so an existing credential helper or user Docker configuration does
not interfere. Keep the current engine selection: the initializer does not set
`DOCKER_HOST`. For example, a Colima profile can use
`DOCKER_HOST="unix://$HOME/.colima/wagglebot-phase2/docker.sock"`; use the
socket path for the local engine you started.

## Initialize and start

Run from the repository root. The state directory must be new and absolute.
The default gateway port is 8443; pass another port as the third initializer
argument if needed.

```sh
bun install --frozen-lockfile
bun run build
bun deploy/init-phase2.ts "$PWD/.wagglebot-phase2-stack"
export DOCKER_CONFIG="$PWD/.wagglebot-phase2-stack/client/docker"
```

Choose the Compose command installed on the host and start project
`wagglebot-phase2`:

```sh
docker compose --env-file "$PWD/.wagglebot-phase2-stack/.env" \
  -f deploy/compose.yaml -p wagglebot-phase2 \
  up --build --detach --wait --wait-timeout 300
```

With the standalone CLI, replace `docker compose` with `docker-compose`.
Compose builds the worker and service images, applies the database migrations,
then waits for the gateway and its dependencies to become healthy.

## Run the end-to-end smoke

Run this from the repository root with the same `DOCKER_CONFIG` and
`DOCKER_HOST`:

```sh
bun --env-file=.wagglebot-phase2-stack/.env \
  services/context-engine/integration/phase2-compose.ts \
  "$PWD/.wagglebot-phase2-stack"
```

The smoke exercises verified HTTPS, SSH-based auth, registry authorization,
memory writes and retrieval, the native hub/MCP path, reviewed publication,
admin jobs, restart replay, database/log privacy, and offline local retrieval.
It stops the gateway and shared app services to prove local retrieval still
works. Start them again with the same `up --detach --wait` command (without
`--build`) when finished:

```sh
docker compose --env-file "$PWD/.wagglebot-phase2-stack/.env" \
  -f deploy/compose.yaml -p wagglebot-phase2 \
  up --detach --wait --wait-timeout 300
```

The smoke changes the fixture company history and database contents. It is not
idempotent: use a fresh state directory and fresh Compose volumes for each run.
To reuse the project name, remove the previous project first. Run
`down --volumes` only for disposable fixture data; it deletes the named
PostgreSQL and model cache volumes:

```sh
docker compose --env-file "$PWD/.wagglebot-phase2-stack/.env" \
  -f deploy/compose.yaml -p wagglebot-phase2 down --volumes
```

Use `docker-compose` in place of `docker compose` when using the standalone
CLI.

## State and trust boundaries

The state directory is created with mode `0700`; its `.env` and client
credentials are protected there. Public certificates and the fixture's
company files have mode `0644` beneath that protected directory. Compose mounts
only the files each service needs: the auth signing key goes only to auth, the
auth public key goes to registry and memory, the CA goes to the migrator and
memory, and the TLS server key goes only to the gateway. PostgreSQL receives
its own server certificate and key. The client SSH private key and CA private
key are never mounted into containers.

The generated CA and leaf certificates expire after 30 days. Initialize a new
fixture state and recreate its project when they expire. Keep certificate
verification enabled; the worker uses `sslmode=verify-full` for PostgreSQL,
and the smoke trusts the generated CA directly.

Only the gateway has a host-published port, bound to loopback. PostgreSQL,
auth, registry, and memory are available to other Compose services on the
private Compose network. The named PostgreSQL volume persists across restarts;
the named model cache avoids downloading the embedding model on every worker
start.
