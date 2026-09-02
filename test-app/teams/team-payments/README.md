# Team team-payments

Everything in this directory applies to the members of the Group `team-payments` only.
The directory name must equal the Group name in `catalog.yaml`.

| File | Purpose |
|---|---|
| `catalog.yaml` | The Group, its Users, and the Domains and Systems it owns. Required. |
| `registry.yaml` | MCP servers for this team. Same format as `company/registry.yaml`. |
| `skills.list` | Skills for this team. Same format as `company/skills.list`. |
| `agents.list` | Shared subagents from other repositories. Same format as `company/agents.list`. |
| `agents/*.md` | Subagents for this team. |
| `instructions/*.md` | Instructions appended after the company instructions. |

Every file except `catalog.yaml` is optional.
