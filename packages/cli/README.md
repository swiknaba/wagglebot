# wagglebot

One AI agent setup for a whole engineering team.

This package installs the Phase 1 provisioning layer: the curated
skills, the curated subagents, one base prompt in every agent harness,
and MCP server configs from a shared registry. Every mutation lands
inside a managed block. Content outside that block stays untouched.

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
| `wagglebot write-mcp` | Writes MCP server configs from the registry into every harness. |

Run `wagglebot --help` for the full file-by-file breakdown, or
`wagglebot <command> --help` for the same text.

## Specs

The design and the Phase 1 specification live at
[github.com/swiknaba/wagglebot](https://github.com/swiknaba/wagglebot).
