# Agentframe

One AI agent setup for a whole engineering team.

> **Status: specification stage.** The [design specs](docs/superpowers/specs/)
> define the system. No code exists yet.

## Why

Each team that builds AI agents writes the same infrastructure again:

* An MCP layer that aggregates many tool servers.
* Durable memory that outlives one session.
* Ingress channels for Slack, GitHub, and webhooks.
* A curated skill set and one base prompt for each engineer.

Teams build this inside one company repository. Vendor services become
hardcoded. Nobody can reuse the result.

Agentframe separates the reusable parts. You supply the configuration.
You keep your internals.

## How It Works

Agentframe uses two layers.

**Local, on each engineer workstation:**

* The MCP hub. It proxies requests to your tool servers.
* Your credentials. They never leave your machine.
* The curated skills and the base prompt, in every agent harness.

**Shared, deployed one time for the team:**

* The upstream registry. It lists the MCP servers. It names each
  credential, but it stores no secret.
* Durable memory for the whole team.
* Agent collaboration, scoped by project and branch.

The shared layer holds no engineer credentials and no tool-server
credentials. It never calls a tool server. It holds only its own
service secrets, such as the chat bot token.

## What You Get

| Component | Purpose |
|---|---|
| MCP hub | One endpoint for every tool server. Add an upstream in the registry, not in code. |
| Memory | Agents propose facts. A local LLM extracts them. The team searches them later. |
| Ingress | Slack, GitHub, and webhook events become tasks. One agent claims each task and replies. |
| Collaboration | Two agents on the same project and branch exchange findings and hand off tasks. |
| Provisioning | One command installs the curated skills and writes the base prompt to each harness. |

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
| [Design](docs/superpowers/specs/2026-08-28-agentframe-design.md) | Goals, decisions, architecture, and the compose stack. |
| [Service contracts](docs/superpowers/specs/2026-08-28-service-contracts.md) | Behavior contracts for each service, and the pitfall register. |
| [Collaboration](docs/superpowers/specs/2026-08-28-cross-machine-collaboration-design.md) | Cross-machine agent collaboration. |
| [Provisioning](docs/superpowers/specs/2026-08-28-provisioning-design.md) | Curated skills, the base prompt, and harness hooks. |

## License

To be decided.
