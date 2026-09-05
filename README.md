# Wagglebot

One AI agent setup for a whole engineering team.

> **Status.** Phase 1 workstation provisioning is implemented in
> [`packages/cli`](packages/cli/). Repository instruction sync remains
> specified but not implemented. Phases 2–4 stay at the specification
> stage. The [design specs](docs/superpowers/specs/) define the system.

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
* The MCP server configs, from one curated registry.
* Your credentials stay on your machine in one gitignored file, and
  load into every new shell.

Phase 1 also specifies `wagglebot sync-project`. It publishes local
`.agents/instructions/*.md` files to each supported agent harness.

An engineer clones, installs, runs the update, and works. Nothing
listens on a port, and git access is the whole permission system. A
wagglebot upgrade is a one-line version bump in the company
`package.json`, reviewed like any pull request.

**Phase 2 — shared, deployed one time for the team:**

* Durable memory for the whole team.
* The registry served per team, and the MCP hub as an upgrade.

**Phase 3 — collaboration:** agents on different machines discover each
other, exchange findings, and hand off tasks, scoped by system and
branch.

The shared layer holds no engineer credentials and no tool-server
credentials. It never calls a tool server. It holds only its own
service bearer tokens.

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
* **Deployment-agnostic.** The project ships containers and a compose
  file. Run them anywhere.
* **Local-first.** One command starts a working stack. The extraction
  model runs on a CPU. Development needs no cloud account.
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
| [Phase 2 — shared layer](docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md) | The memory worker, the hub, auth, and the compose stack. |
| [Phase 3 — collaboration](docs/superpowers/specs/2026-08-28-phase-3-collaboration.md) | Cross-machine agent collaboration. |
| [Phase 4 — ingestion](docs/superpowers/specs/2026-08-28-phase-4-document-ingestion.md) | Documents into memory, with an optional batch extractor. |
| [Service contracts](docs/superpowers/specs/2026-08-28-service-contracts.md) | Behavior contracts for each service, and the pitfall register. |

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

Regenerate `test-app/` after any change to the scaffold templates or
the package version:

```sh
bun run regen:test-app
```

Commit the result. The end-to-end test fails, and names the drifted
file, when `test-app/` falls behind the real scaffold output.

## License

MIT
