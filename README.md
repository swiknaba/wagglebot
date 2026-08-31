# Wagglebot

One AI agent setup for a whole engineering team.

> **Status: specification stage.** The [design specs](docs/superpowers/specs/)
> define the system. No code exists yet.

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
* Your credentials stay on your machine, in one gitignored file.

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

## Documentation

| Spec | Content |
|---|---|
| [Design](docs/superpowers/specs/2026-08-28-wagglebot-design.md) | Goals, decisions, architecture, and the phase index. |
| [Phase 1 — provisioning](docs/superpowers/specs/2026-08-28-phase-1-provisioning.md) | One command: skills, subagents, base prompts, MCP configs, local memory. |
| [Phase 2 — shared layer](docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md) | The memory worker, the hub, auth, and the compose stack. |
| [Phase 3 — collaboration](docs/superpowers/specs/2026-08-28-phase-3-collaboration.md) | Cross-machine agent collaboration. |
| [Phase 4 — ingestion](docs/superpowers/specs/2026-08-28-phase-4-document-ingestion.md) | Documents into memory, with an optional batch extractor. |
| [Service contracts](docs/superpowers/specs/2026-08-28-service-contracts.md) | Behavior contracts for each service, and the pitfall register. |

## Releasing

Maintainers release with one command. CI does the publish.

1. Bump the version in `packages/cli/package.json`, in a reviewed pull
   request.
2. Run `bin/release` on `main`, with a clean worktree.
3. Select major, minor, or patch. Confirm.

The script verifies the version, creates the git tag, pushes it, and
creates the GitHub release with generated notes. The GitHub release
triggers `.github/workflows/release.yml`, which publishes the package
to npm with provenance.

No npm token exists. The workflow authenticates through npm trusted
publishing (OIDC): npm accepts the publish because the run comes from
`release.yml` in this repository. A failed CI publish leaves the tag
and the release in place — fix the cause and re-run the workflow.

Watch the publish: `gh run watch`.

## License

MIT
