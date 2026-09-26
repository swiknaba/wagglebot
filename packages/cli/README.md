# wagglebot

This package provides Phase 1 local provisioning. It configures all supported
harnesses and preserves personal content outside Wagglebot-owned content.

Requires Node 22.20 or newer. It runs on macOS, Linux, and Windows through
WSL. Native Windows shells, PowerShell, and cmd are unsupported.

## Engineer flow

```sh
npm install --global wagglebot@<version>
wagglebot connect <company-git-url>
wagglebot update --wagglebot
cd my-project
wagglebot init
wagglebot update
```

`connect` is optional when the installed company package contains a real URL.
The official package contains `git@company.example:platform/mycompany-wagglebot.git`
as documentation only. A `.example` host is reserved, counts as unset, and is
never fetched.

The company update uses a private cache under `~/.wagglebot/company/`.
Engineers run it after the company announces a reviewed change. Project `init`
and `update` do not need company configuration.

## Administrator flow

```sh
wagglebot init --wagglebot mycompany-wagglebot
cd mycompany-wagglebot
git init
npm install
wagglebot update
```

Inside a marked company repository, plain `update` uses the current working
tree, including uncommitted changes. Use this mode to test a change before publication.

## Commands

| Command | Purpose |
|---|---|
| `wagglebot connect <git-url>` | Store a company repository URL without credentials. |
| `wagglebot init` | Initialize a Git project and publish its first instructions. |
| `wagglebot update` | Update project outputs, or provision a marked company working tree. |
| `wagglebot init --wagglebot [directory]` | Scaffold a marked company repository. |
| `wagglebot update --wagglebot` | Refresh the company cache and provision the exact package pin. |
| `wagglebot install-skills` | Install curated skills from company layers. |
| `wagglebot install-agents` | Install compatible custom agents. |
| `wagglebot sync-harnesses` | Synchronize global instructions and compatible hooks. |
| `wagglebot sync-shell` | Synchronize the credential-loading shell block. |
| `wagglebot write-mcp` | Write compatible MCP configurations. |

Run `wagglebot --help` for public command help. Compatibility aliases remain
available for one release but do not appear in primary help. See the
[migration guide](https://github.com/swiknaba/wagglebot/blob/main/docs/phase-1-command-migration.md) for their mappings.

## Safety

Wagglebot stores a repository URL only. Git uses existing SSH or HTTPS
authentication. It never stores credentials. MCP entries use safe environment
variable references or are skipped. Cached shells load `~/.wagglebot/.env.credentials` outside immutable revisions.
Working-tree shells load the gitignored `.env.credentials` at the company root.

Default company updates preserve personal content. `--overwrite-local` replaces
only documented instruction, skill, custom-agent, hook, and MCP categories. It
creates no backup and asks for no confirmation. Project mode rejects it.

Read the [onboarding guide](https://github.com/swiknaba/wagglebot/blob/main/docs/phase-1-onboarding.md) and the
[harness reference](https://github.com/swiknaba/wagglebot/blob/main/docs/harnesses.md) before a deployment.
