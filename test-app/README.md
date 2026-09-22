# Company Agent Environment

Provisioned by [wagglebot](https://github.com/swiknaba/wagglebot) 0.2.1.

## Before Your First Run

The catalog is optional. An unknown engineer receives the company layer and a
warning. Add a User and Group membership when that engineer needs a team layer.

You need Node 22.20 or newer. Run `nvm use` in this directory.

On Windows, use WSL. Native Windows shells are unsupported. Run each harness
inside the same WSL distribution as Wagglebot.

## Setup

Create this repository with:

```sh
wagglebot init --wagglebot mycompany-wagglebot
cd mycompany-wagglebot
git init
npm install
wagglebot update
```

After the scaffold exists, run this sequence again only to provision local
company changes.

1. Run `git init`.
2. Run `npm install`.
3. Run `wagglebot update`.
4. Open a new terminal.

The first run asks for your company Git username once and stores it in your
global git config. It provisions all nine local adapters. Run it after each
reviewed company update.

## Harnesses

Wagglebot provisions all nine supported adapters. It creates required target
directories. See the repository harness reference for paths and safe skips.

## Credentials

For a company working tree, copy `.env.credentials.example` to the gitignored `.env.credentials` at its root.
For cached mode, copy the example to `~/.wagglebot/.env.credentials`.
Enter the required values in the personal file. Never commit credentials.
`wagglebot update` adds a managed block to `~/.zshenv` or `~/.bashrc`.
The block selects the personal file for the current mode.
Start each harness from a new terminal to load the variables.
Cache refresh preserves the personal file outside its immutable revisions.

## Layout

| Path | Applies to | Content |
|---|---|---|
| `company/` | Everyone | `registry.yaml`, `skills.list`, `agents.list`, `agents/`, `instructions/`, optional `catalog.yaml` |
| `teams/<team>/` | Members of Group `<team>` | The same files. `catalog.yaml` is optional. |

The directory name under `teams/` must equal the Group name. Every
`catalog.yaml` merges into one catalog. An unknown engineer receives only the
company layer and a warning.

## Pins

An entry in a `skills.list` or an `agents.list` that points outside
your organization must pin a tag. Wagglebot prints a warning for each
unpinned third-party entry. List the repositories that your
organization owns under `wagglebot.organization` in `package.json`, as
`host/path` prefixes:

    "wagglebot": { "organization": ["github.com/acme", "git.acme.local"] }

An entry under one of these prefixes may skip the pin, because a pull
request already reviews it.

## Upgrade

Bump the `wagglebot` pin in `package.json` in a pull request. Review
the wagglebot changelog for base-template changes.
