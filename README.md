# Wagglebot

Wagglebot gives each engineering team one local AI-agent setup.

> **Status.** Phase 1 is complete. It provisions nine local harnesses from a
> company repository without a Wagglebot service. Phase 2 is in progress. See
> the [Phase 1 onboarding](docs/phase-1-onboarding.md) and the
> [implementation sequence](docs/superpowers/plans/2026-09-12-phase-2-implementation-sequence.md).

## Phase 1

Phase 1 installs curated skills, custom agents, global instructions, compatible
hooks, shell credential loading, and MCP configurations. It also publishes
project instructions and creates committed project memory and changelog files.

An engineer does not keep a visible company clone. `wagglebot connect` records
the company URL. `wagglebot update --wagglebot` refreshes the private cache and
uses the exact package pin from the validated company revision.

Administrators scaffold with `wagglebot init --wagglebot mycompany-wagglebot`,
then run `cd mycompany-wagglebot`, `git init`, `npm install`, and `wagglebot update`.

Use these guides:

* [Engineer and administrator onboarding](docs/phase-1-onboarding.md)
* [Command migration](docs/phase-1-command-migration.md)
* [Harness reference](docs/harnesses.md)

Phase 1 runs on macOS, Linux, and Windows through WSL. Native Windows shells,
PowerShell, and cmd are unsupported.

## Later phases

Phase 2 adds the shared memory layer, D26 authentication, an authenticated
registry, and the MCP hub. Phase 3 adds collaboration between machines. Phase 4
adds document ingestion.

Shared services do not store engineer or tool-server credentials. Those values
remain on the engineer workstation.

## Documentation

| Document | Content |
|---|---|
| [Current Phase 1 design](docs/superpowers/specs/2026-09-21-phase-1-polish-design.md) | Approved local provisioning behavior and test contract. |
| [Original design](docs/superpowers/specs/2026-08-28-wagglebot-design.md) | Goals, decisions, architecture, and phase index. |
| [Phase 2 shared layer](docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md) | Memory worker, deployment, hub, and authentication. |
| [Phase 3 collaboration](docs/superpowers/specs/2026-08-28-phase-3-collaboration.md) | Cross-machine agent collaboration. |
| [Phase 4 ingestion](docs/superpowers/specs/2026-08-28-phase-4-document-ingestion.md) | User ingestion workers and source metadata. |
| [Harness reference](docs/harnesses.md) | Every global path, hook, agent directory, and MCP target. |

## Test app

`test-app/` is the complete company fixture and drift gate. CI runs two offline
company updates and verifies every compatible output. No test starts a harness,
service, or LLM.

Regenerate the fixture after scaffold or package changes:

```sh
bun run regen:test-app
git diff --exit-code -- test-app
```

Commit the regenerated fixture when the change is intentional.

## License

MIT
