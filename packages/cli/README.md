# wagglebot

One AI agent setup for a whole engineering team.

This package installs the Phase 1 provisioning layer. It installs the
curated skills, the curated subagents, and one base prompt in every
agent harness. It also installs MCP server configs from a shared
registry, and a shell block that loads the engineer's credentials. The
package also publishes the repository's own instructions to every
harness. Every mutation lands inside a managed block. Content outside
that block stays untouched.

Requires Node 22.20 or newer. Runs on macOS, on Linux, and on Windows
through the Windows Subsystem for Linux (WSL). The native Windows
shells, PowerShell and cmd, are out of scope. Under WSL, run this CLI
and the agent harness in the same environment, because wagglebot
provisions one home directory.

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
| `wagglebot update` | Pulls the company repo, then syncs skills, subagents, the base prompt, and MCP configs. |
| `wagglebot init [dir]` | Scaffolds a new company repository. |
| `wagglebot install-skills` | Syncs the curated skills list: installs new skills, removes deleted ones. |
| `wagglebot install-agents` | Installs the shared subagents: the company `agents/` directory, plus the curated list. |
| `wagglebot sync-agents` | Syncs the base prompt, plus the company instructions, into every harness. |
| `wagglebot sync-project` | Publishes this repository's `.agents/instructions/` to every project target. |
| `wagglebot sync-shell` | Adds a managed block to the shell startup files that loads `.env.credentials`. |
| `wagglebot write-mcp` | Writes MCP server configs from the registry into every harness. |

Run `wagglebot --help` for the full file-by-file breakdown, or
`wagglebot <command> --help` for the same text.

## Project Instructions

`wagglebot sync-project` publishes this repository's own instructions
from `.agents/instructions/*.md`, sorted by name:

```
.agents/instructions/
  code-style.md
  testing.md
```

It writes four targets: root `AGENTS.md` (Codex, Junie, Cline), root
`CLAUDE.md` (Claude Code, a managed `@AGENTS.md` import), root
`GEMINI.md` (Gemini CLI, a managed `@./AGENTS.md` import), and
`.github/copilot-instructions.md` (GitHub Copilot CLI).

Removing a source file removes stale content only from the blocks that
wagglebot owns. A file left with only whitespace after that removal is
deleted. A file that still holds other content keeps that content.
Every target sits inside the repository, so git is the backup and the
undo.

The command needs no company repository. Run it from a pinned global
install:

```sh
npm install --global wagglebot@<version>
wagglebot sync-project
```

## Workstation Settings

Wagglebot stores two settings in the engineer's global git config.
`wagglebot.username` holds the company Git username, asked once on
the first run. `wagglebot.harnesses` holds an explicit, comma-separated
harness list, and overrides detection when set. Without it, wagglebot
provisions every harness whose home directory already exists.

## Specs

The design and the Phase 1 specification live at
[github.com/swiknaba/wagglebot](https://github.com/swiknaba/wagglebot).
