# Company Agent Environment

Provisioned by [wagglebot](https://github.com/swiknaba/wagglebot) {{WAGGLEBOT_VERSION}}.

## Setup

1. Run `git clone <this repo>`.
2. Run `yarn install`.
3. Run `yarn update:wagglebot`.

The last command provisions this workstation: skills, subagents, base
prompts, and MCP configs, in every agent harness. Run it again after
each merge to this repository.

## Company Instructions

Files in `instructions/` are appended to the shared base prompt and
written to the global instructions file of every harness. Add one file
per topic.

## Shared Subagents

Files in `agents/` install as subagents on every workstation. Subagents
maintained in another repository are listed in `agents.base.list`.

## Credentials

Copy `.env.credentials.example` to `.env.credentials` and fill the
values. The file is gitignored. No credential ever enters this
repository.

## Upgrade

Bump the `wagglebot` pin in `package.json` in a pull request. Review
the wagglebot changelog for base-template changes.
