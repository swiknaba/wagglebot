# Wagglebot

One AI agent setup for a whole engineering team.

> **Status.** Phase 1 is complete. Phase 2 is in progress: the local Repository
> Brain, SSH authentication, authenticated registry, and Sequel migration
> service are implemented. The MCP hub has its configuration, credential,
> trust, and registry-refresh foundations, but no runnable server yet. The
> shared-memory worker, unified context engine, and Context Bridge are not
> built. See the [implementation sequence](docs/superpowers/plans/2026-09-12-phase-2-implementation-sequence.md)
> for the current boundary.

## Why

Each team that builds AI agents writes the same infrastructure again:

* An MCP layer that aggregates many tool servers.
* Durable memory that outlives one session.
* A curated skill set and one base prompt for each engineer.

Teams build this inside one company repository. Vendor services become
hardcoded. Nobody can reuse the result.

Wagglebot separates the reusable parts. You supply the configuration.
You keep your internals.

## How It Works

Wagglebot uses two layers.

**Phase 1 — local, zero services.** Wagglebot is a pinned npm package
inside one company repository (like React, or Backstage). Three
commands — `git clone <company repo>`, `yarn install`,
`yarn update:wagglebot` — install on every workstation:

* The curated skills and subagents.
* The base prompt, in every agent harness.
* The MCP server configs, from one curated registry, in every
  harness ([harness reference](docs/harnesses.md)).
* Your credentials stay on your machine in one gitignored file, and
  load into every new shell.

`wagglebot sync-project` publishes the repository's own instructions.
It reads `.agents/instructions/*.md` and writes root `AGENTS.md`, root
`CLAUDE.md`, root `GEMINI.md`, and `.github/copilot-instructions.md`.
The command runs from any Git repository, without the company
repository. Every target sits inside the repository, so git is the
undo.

An engineer clones, installs, runs the update, and works. Nothing
listens on a port, and git access is the whole permission system. A
wagglebot upgrade is a one-line version bump in the company
`package.json`, reviewed like any pull request.

**Phase 2 — shared, deployed one time for the team (in progress):**

* Durable memory for the whole team.
* The registry served per team, and the MCP hub as an upgrade.

**Phase 3 — collaboration:** agents on different machines discover each
other, exchange findings, and hand off tasks, scoped by system and
branch.

The shared services hold no engineer credentials or tool-server credentials
and never call a tool server. Authentication session tokens authorize calls to those
services. Upstream credentials remain on the engineer workstation, where the
local MCP hub will use them.

## What You Get

| Component | Purpose |
|---|---|
| Provisioning | One command installs the curated skills, the subagents, and the base prompt in each harness. |
| MCP configs | One curated registry writes each harness config. The hub (Phase 2) upgrades that to one endpoint. |
| Memory | The agent writes facts about one repository to a local file, in git (Phase 1). Facts that cross a repository go to the shared store (Phase 2). |
| Collaboration | Two agents on the same system and branch exchange findings and hand off tasks. (Phase 3) |

## Design Principles

* **Vendor-neutral.** No SaaS integration is hardcoded. Each upstream
  comes from your catalog.
* **Runtime-agnostic.** Any agent runtime connects over HTTP and MCP.
* **Deployment-agnostic.** Implemented services ship individual Dockerfiles.
  A complete composed Phase 2 stack is planned but not available yet.
* **Local-first.** Phase 1 and the Repository Brain require no shared stack.
  The planned shared-memory worker runs CPU embeddings without a cloud model.
* **Credentials stay local.** Engineer credentials and tool-server
  credentials stay on each workstation. Shared channel secrets stay in
  the shared deployment.
* **Trusted coworkers.** Identity serves routing, context, and
  attribution. Git and your identity provider control code access.

## Platform Support

Wagglebot runs on macOS, on Linux, and on Windows through the Windows
Subsystem for Linux (WSL). Wagglebot does not support the native
Windows shells, PowerShell and cmd.

Under WSL, install and run wagglebot inside the WSL distribution.
Three points apply:

* Run the agent harness inside WSL too. Wagglebot provisions one home
  directory, the Linux one. A harness that you install on the Windows
  side reads `C:\Users\<user>\` and finds nothing there.
* Keep the company repository under your Linux home directory. The
  `/mnt/c` mount is slow, and it discards the `chmod 600` mode that
  protects each managed file.
* The shell block lands in `~/.bashrc` on a distribution that ships
  bash alone, and in `~/.zshenv` when you use zsh.

## Documentation

| Spec | Content |
|---|---|
| [Design](docs/superpowers/specs/2026-08-28-wagglebot-design.md) | Goals, decisions, architecture, and the phase index. |
| [Phase 1 — provisioning](docs/superpowers/specs/2026-08-28-phase-1-provisioning.md) | Workstation setup plus local project instruction sync. |
| [Phase 2 — shared layer](docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md) | The memory worker, required Sequel migrations, database deployment, the hub, and auth. |
| [Phase 3 — collaboration](docs/superpowers/specs/2026-08-28-phase-3-collaboration.md) | Cross-machine agent collaboration. |
| [Phase 4 — ingestion](docs/superpowers/specs/2026-08-28-phase-4-document-ingestion.md) | User ingestion workers, isolated knowledge bases, and source metadata. |
| [Admin dashboard](docs/superpowers/specs/2026-09-13-admin-dashboard.md) | Developer UI, task controls, and database metrics. |
| [Service contracts](docs/superpowers/specs/2026-08-28-service-contracts.md) | Behavior contracts for each service, and the pitfall register. |
| [Harness reference](docs/harnesses.md) | Every file wagglebot writes per harness, and the MCP config format of each. |
| [Deployment configuration](deploy/README.md) | Implemented service containers and their environment blocks. |

## Releasing

* The package is published on [npm](https://www.npmjs.com/package/wagglebot).
* GitHub releases serve as the changelog.
* Run `bin/release` to do both.

## Test App

`test-app/` is a company repository. `wagglebot init` scaffolds it. It
serves as the reference output of the CLI.

An end-to-end test in CI runs the full provisioning flow against a
sandboxed home directory. The flow covers the base prompt sync, the
hooks, and the shell block. `test-app/` serves as the drift gate for
the scaffold output.

The CodeGraph SDK integration tests require the platform-specific optional
CodeGraph bundle. They are excluded from the portable test suite; run
`bun run test:codegraph-integration` on a machine with that bundle installed.

Regenerate `test-app/` after any change to the scaffold templates or
the package version:

```sh
bun run regen:test-app
```

Commit the result. The end-to-end test fails, and names the drifted
file, when `test-app/` falls behind the real scaffold output.

## License

MIT
