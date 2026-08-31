# Company Agent Environment

Provisioned by [wagglebot](https://github.com/swiknaba/wagglebot) 0.0.1.

## Setup

1. Run `git clone <this repo>`.
2. Run `yarn install`.
3. Run `yarn update:wagglebot`.

The last command provisions this workstation: skills, subagents, base
prompts, and MCP configs, in every agent harness. Run it again after
each merge to this repository.

## Credentials

Copy `.env.credentials.example` to `.env.credentials` and fill the
values. The file is gitignored. No credential ever enters this
repository.

## Upgrade

Bump the `wagglebot` pin in `package.json` in a pull request. Review
the wagglebot changelog for base-template changes.
