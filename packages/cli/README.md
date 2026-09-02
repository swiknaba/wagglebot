# wagglebot

One AI agent setup for a whole engineering team.

This package installs the Phase 1 provisioning layer. It installs the
curated skills, the curated subagents, and one base prompt in every
agent harness. It also installs MCP server configs from a shared
registry, and a shell block that loads the engineer's credentials.
Every mutation lands inside a managed block. Content outside that
block stays untouched.

Requires Node 22.20 or newer.

## The Engineer Flow

An engineer runs three commands.

```sh
git clone <company repo>
yarn install
yarn update:wagglebot
```

The `update` command pulls the company repository, then reinstalls the
skills, the subagents, the base prompt, and the MCP configs for every
harness on the workstation.

## Commands

| Command | What it does |
|---|---|
| `wagglebot update` | Pulls the company repo, then reinstalls skills, subagents, the base prompt, and MCP configs. |
| `wagglebot init [dir]` | Scaffolds a new company repository. |
| `wagglebot install-skills` | Installs the curated skills list. |
| `wagglebot install-agents` | Installs the shared subagents: the company `agents/` directory, plus the curated list. |
| `wagglebot sync-agents` | Syncs the base prompt, plus the company instructions, into every harness. |
| `wagglebot sync-shell` | Adds a managed block to the shell startup files that loads `.env.credentials`. |
| `wagglebot write-mcp` | Writes MCP server configs from the registry into every harness. |

Run `wagglebot --help` for the full file-by-file breakdown, or
`wagglebot <command> --help` for the same text.

## Workstation Settings

Wagglebot stores two settings in the engineer's global git config.
`wagglebot.username` holds the company Git username, asked once on
the first run. `wagglebot.harnesses` holds an explicit, comma-separated
harness list, and overrides detection when set. Without it, wagglebot
provisions every harness whose home directory already exists.

## Specs

The design and the Phase 1 specification live at
[github.com/swiknaba/wagglebot](https://github.com/swiknaba/wagglebot).
