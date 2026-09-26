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
Run `npm install` in that working tree before its first update and after a package pin change.

Cached mode now uses `~/.wagglebot/.env.credentials` outside cache revisions.
The next cache refresh or cached shell sync prepares migration when the stable path is absent.
Both paths temporarily reference the same file. Wagglebot does not read or copy its values.
Wagglebot removes the legacy path only after shell configuration succeeds.
If runtime installation or shell configuration fails during migration, Wagglebot restores the prior active cache.
Both old and updated shell blocks can load credentials after that failure. Run the update again after you correct the failure.
A shell-stage receipt identifies the configured revision. Other provisioning failures do not reverse a completed credential migration.
An existing personal file takes precedence and leaves a separate legacy file untouched.
If an older refresh already stranded your file, move it from the prior revision to the new personal path.
Do not commit credential values. Working-tree mode continues to use the gitignored root `.env.credentials`.

The `.example` default is reserved documentation data. It is unset and never
fetchable. Run `wagglebot connect <company-git-url>` to save a real URL.
