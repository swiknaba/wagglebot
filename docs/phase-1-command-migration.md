# Phase 1 Command Migration

Compatibility aliases remain available for one release. Primary help does not
list them.

| Previous workflow | Current workflow | Reason |
|---|---|---|
| `wagglebot sync-project` | `wagglebot update` in a normal Git project | Project update publishes project instructions. |
| `wagglebot sync-agents` | `wagglebot sync-harnesses` | The new name includes global instructions and compatible hooks. |
| A visible company checkout | `wagglebot connect <company-git-url>` and `wagglebot update --wagglebot` | Wagglebot uses a private validated cache. |
| `wagglebot.harnesses` selection or detection | Provision all nine adapters | Each update creates required directories and configures compatible features. |
| `yarn update:wagglebot` | `wagglebot update --wagglebot` | The update selects the exact company package pin. |

Run `wagglebot init` in a normal Git project. Then run `wagglebot update` to
republish its instructions. Run `wagglebot init --wagglebot [directory]` to
scaffold a company repository. Inside its marked Git root, plain `update` uses
the current working tree and uncommitted changes.

The `.example` default is reserved documentation data. It is unset and never
fetchable. Run `wagglebot connect <company-git-url>` to save a real URL.
