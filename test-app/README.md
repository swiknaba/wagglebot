# Company Agent Environment

Provisioned by [wagglebot](https://github.com/swiknaba/wagglebot) 0.1.0.

## Before Your First Run

You need a User entity in the catalog. Ask your team to add you to
`teams/<team>/catalog.yaml`: one `User` entity with your company Git
username, and your name in the `members` of the team Group. Merge that
pull request first.

You need Node 22.20 or newer. Run `nvm use` in this directory.

On Windows, do all of this inside the Windows Subsystem for Linux
(WSL). Clone this repository under your Linux home directory, not
under `/mnt/c`. Install your agent harness inside WSL too, because the
provisioning writes to the Linux home directory only.

## Setup

1. Run `git clone <this repo>`.
2. Run `yarn install`.
3. Run `yarn update:wagglebot`.
4. Open a new terminal.

The first run asks for your company Git username once and stores it in
your global git config. It then provisions this workstation: skills,
subagents, base prompts, MCP configs, and a shell block that loads your
credentials. Run it again after each merge to this repository.

## Which Harnesses

Wagglebot provisions every agent harness whose directory exists under
your home directory, for example `~/.claude` or `~/.codex`. To choose
explicitly, run:

    git config --global wagglebot.harnesses claude-code,codex

Run `yarn wagglebot --help` for the valid names.

## Credentials

Copy `.env.credentials.example` to `.env.credentials` and fill the
values. The file is gitignored. No credential ever enters this
repository. `wagglebot update` adds a block to the startup file of your
shell, `~/.zshenv` for zsh or `~/.bashrc` for bash. The block exports
the file into every new shell. Start an agent harness from a new
terminal so it sees the variables.

## Layout

| Path | Applies to | Content |
|---|---|---|
| `company/` | Everyone | `registry.yaml`, `skills.list`, `agents.list`, `agents/`, `instructions/`, optional `catalog.yaml` |
| `teams/<team>/` | Members of Group `<team>` | The same files. `catalog.yaml` is required. |

The directory name under `teams/` must equal the Group name. Every
`catalog.yaml` merges into one catalog, and an unknown name is a hard
error.

## Upgrade

Bump the `wagglebot` pin in `package.json` in a pull request. Review
the wagglebot changelog for base-template changes.
