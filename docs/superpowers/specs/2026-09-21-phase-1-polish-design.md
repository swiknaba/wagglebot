# Phase 1 Polish and Harness Expansion

> This design replaces the incomplete Phase 1 completion claim. Phase 1 is
> complete only when the behavior and tests in this document are implemented.

## Goal

Phase 1 gives every engineer one stable agent setup without a Wagglebot
service. One company Git repository defines the shared setup. Wagglebot writes
that setup into each supported local harness and publishes one project
instruction source into each supported project target.

The setup contains:

- Base instructions for all engineers.
- Optional team instructions for catalog members.
- Curated skills and custom agents.
- Equivalent hooks where a harness supports them.
- Compatible MCP server configurations.
- Committed project memory and an agent changelog.

The CLI never invokes an LLM. Phase 1 runs on macOS, Linux, and Windows through
WSL. Native Windows shells remain unsupported.

## Supported harnesses

Phase 1 officially supports these nine harnesses:

1. Claude Code.
2. OpenAI Codex.
3. JetBrains Junie.
4. Gemini CLI.
5. GitHub Copilot.
6. Cline.
7. Cursor.
8. Devin Desktop, formerly Windsurf.
9. Kiro.

Devin support covers local Devin Desktop only. The Devin cloud agent is out of
scope.

Official support means that automated tests prove the supported instructions,
skills, custom agents, hooks, and MCP behavior. The tests do not start a
harness or invoke its LLM.

## Architecture

Keep the existing adapter design and extend it. One capability table defines
the following facts for each harness:

- Global instruction target.
- Project instruction target.
- Skill target or installer identifier.
- Custom agent target.
- Hook target and event mapping.
- MCP configuration path, format, transports, and credential features.

Shared code performs the common work. A harness adapter contains only vendor
differences. It can report a feature as unsupported. An unsupported feature
does not make another feature unavailable.

Wagglebot configures all nine harnesses on every company update. It creates a
required harness directory when the directory does not exist. Phase 1 has no
harness detection setting and no harness selection setting.

## Repository modes

The CLI has two repository modes. It defaults to project mode.

A company repository contains this root marker:

```yaml
# wagglebot.yaml
version: 1
kind: company
```

Wagglebot finds the Git root and reads this exact marker. It does not infer the
mode from a directory name or `package.json.name`.

The `--wagglebot` flag explicitly selects the connected, cached company
repository. A company-only lower-level command uses the current working tree
inside a marked company repository. Outside that repository, the command
requires `--wagglebot` and uses the cache.

## Public command model

### Install the bootstrap CLI

The company announces one exact bootstrap version for first use:

```sh
npm install --global wagglebot@<version>
```

The bootstrap provides `connect` and cached company updates. After connection,
the exact pin in the company repository selects the runtime for provisioning.
The bootstrap does not silently replace the global npm package.

### Connect a workstation

```sh
wagglebot connect <git-url>
```

This command stores an explicit company repository URL in
`~/.wagglebot/config.json`. It stores no Git credential. Git uses the
engineer's existing SSH or HTTPS authentication. An engineer does not need to
run this command when the installed package contains the correct company URL.

The installed package can declare a default:

```json
{
  "wagglebot": {
    "companyRepository": "git@company.example:platform/mycompany-wagglebot.git"
  }
}
```

The official package uses this reserved `.example` value as documentation. The
CLI treats a `.example` host as unset and never tries to fetch it. A company
build replaces the value before it publishes the package to its internal
registry. This needs no build-time environment variable.

Resolve the company repository URL in this order:

1. `WAGGLEBOT_COMPANY_REPOSITORY_URL`, as a temporary runtime override.
2. The URL saved by `wagglebot connect`.
3. `wagglebot.companyRepository` in the installed package.
4. A clear error that asks the engineer to run `wagglebot connect`.

### Initialize a project

```sh
wagglebot init
```

In a normal code repository, this command initializes the project files and
then performs the first project update.

### Update a project

```sh
wagglebot update
```

In a normal code repository, this command republishes project instructions and
creates missing project memory files. It replaces the current
`wagglebot sync-project` workflow.

### Initialize a company repository

```sh
wagglebot init --wagglebot [directory]
```

This command scaffolds a company repository and writes `wagglebot.yaml`.

### Update a workstation from the connected company repository

```sh
wagglebot update --wagglebot
```

This command refreshes the company cache and provisions the workstation.

Inside a marked company repository, plain `wagglebot update` uses the current
working tree. It includes uncommitted changes. This behavior lets an
administrator test a company change before publication.

### Lower-level company commands

Keep the lower-level commands public for isolated tests and troubleshooting:

- `install-skills`.
- `install-agents`.
- `sync-harnesses`.
- `sync-shell`.
- `write-mcp`.

Each command uses the marked company working tree when present. Elsewhere it
requires `--wagglebot` and uses the connected cache. `update` runs the complete
ordered sequence.

Keep `sync-project` as a hidden compatibility alias for project `update` for
one release. Keep `sync-agents` as a hidden compatibility alias for
`sync-harnesses` for one release. Do not show either alias in primary help.

## Company repository and cache

The company maintains one shared Git repository. Engineers do not need a
visible clone. Company administrators can use a normal clone for edits and
local tests.

Use these local paths:

```text
~/.wagglebot/config.json
~/.wagglebot/company/
~/.wagglebot/runtime/
```

The company repository pins an exact `wagglebot` npm version. A range, tag,
workspace reference, or floating version is invalid for company updates.

`update --wagglebot` performs this sequence:

1. Fetch the configured Git repository into the company cache.
2. Validate the candidate revision and `wagglebot.yaml`.
3. Read the exact Wagglebot npm pin.
4. Install that version under `~/.wagglebot/runtime` when necessary.
5. Continue the command with the pinned runtime.
6. Resolve the company and team layers.
7. Run each provisioning stage.
8. Print one result summary.

Only a revision with a valid marker, npm pin, and company layer becomes the
active cache. A broken candidate does not replace the last valid revision.
Catalog and team validation occurs after this base validation. A catalog error
cannot make the valid company layer unavailable.

If a Git refresh or base validation fails and a valid cache exists, Wagglebot
provisions from the cache. It reports the stale source and returns a failure
code. If no valid cache exists, it fails without provisioning.

## Company and team layers

The company layer applies to every engineer. A valid catalog can add one or
more team layers.

`catalog.yaml` is optional in Phase 1:

- If no catalog exists, install the company layer and warn.
- If the engineer has no catalog entry, install the company layer and warn.
- If the engineer has catalog entries, add every applicable team layer.
- If the catalog is invalid, install the company layer, report an error, and
  return a failure code.

The first interactive company update asks for the company Git username when
`wagglebot.username` is absent. It stores the answer in global Git
configuration. An unknown username is accepted for company-only provisioning
and produces a warning. A later update adds team layers after the catalog
contains the user.

The catalog remains useful in later phases for access rules and shared memory
scopes. Phase 1 already uses it for team selection.

## Workstation provisioning

A company update runs these stages:

1. Install curated skills.
2. Install shared custom agents.
3. Synchronize global instructions and supported hooks.
4. Synchronize the credential-loading shell block.
5. Write compatible MCP server configurations.

The skills and agent installers read the company lists and every applicable
team list. They install pinned sources. They remove only content that
Wagglebot previously installed and which the effective lists no longer name.

Custom Markdown agents are copied to each harness that supports them. A
harness without a safe custom agent format reports the feature as unsupported.
Phase 1 does not translate a Markdown agent into a runtime agent.

Install equivalent managed hooks when a harness documents a matching hook
feature. A harness without hooks receives the same durable rules through its
instructions.

## Personal content and overwrite mode

The default mode preserves personal content. Wagglebot changes only its owned
files, blocks, keys, entries, and state-tracked installations.

The destructive mode requires an explicit flag on every run:

```sh
wagglebot update --wagglebot --overwrite-local
```

Inside a marked company repository, the same flag works without
`--wagglebot`.

Overwrite mode replaces all content in the supported instruction, skill,
custom agent, hook, and MCP categories with the effective Wagglebot setup. It
does not replace unrelated IDE settings, themes, key bindings, or model
preferences.

The flag is sufficient authorization. Wagglebot does not ask an interactive
confirmation and does not create a backup. Help text must state the exact
targets before the user runs the command.

`--overwrite-local` is invalid in project mode. Project outputs remain
Git-owned and use managed blocks where a target can contain personal content.

## MCP behavior and credentials

Each MCP dialect writes only features that the target harness can represent
safely.

Use these rules:

1. Write an environment variable reference when the harness supports a safe
   reference or variable-name field.
2. When the variable has no value in the current shell, write the safe
   reference and warn.
3. When the harness cannot represent the credential safely, skip only that MCP
   entry and explain why.
4. When the harness does not support the requested transport, skip only that
   entry and explain why.
5. Never write a credential value into a harness configuration.
6. Never write a literal placeholder that the harness would send as a secret.

The company repository includes `.env.credentials.example` and ignores
`.env.credentials`. Wagglebot never writes secret values. The shell stage can
load the engineer-maintained file into new shells.

## Project initialization and update

Project `init` creates this structure when items are missing:

```text
.agents/
  instructions/
  memory.md
  changelog.md
```

Project `update` also creates a missing `memory.md` or `changelog.md`. It does
this even when `.agents/instructions/` contains no Markdown files.

Project instructions come only from sorted
`.agents/instructions/*.md`. The adapter table publishes equivalent content to
every supported project target. Project update preserves content outside
Wagglebot-owned blocks. It must not merge memory, changelog, custom agents, or
other `.agents` files into an instruction target.

Wagglebot never overwrites an existing memory or changelog file. Git provides
review, distribution, history, and recovery for both files. The files must not
be added to `.gitignore`.

`catalog-info.yaml` is not created automatically. The repository onboarding
skill collects the correct owner and system before it writes that file.

## Memory contract

`.agents/memory.md` contains durable facts about the repository. An agent reads
it directly. The base instructions tell agents to update it only with facts
that will help later work.

Phase 1 has no memory service, search server, embedding model, or memory MCP
server. Those features belong to later phases.

## Agent changelog contract

`.agents/changelog.md` records meaningful repository changes made during agent
work sessions. It uses date headings and only the applicable Keep a Changelog
categories:

```markdown
# Agent Changelog

## 2026-09-21

### Added

- Added Cursor support.

### Changed

- Updated the harness configuration flow.
```

The allowed category headings are `Added`, `Changed`, `Fixed`, and `Removed`.
An agent appends concise bullets after it makes a durable repository change.
It does not add an entry for research-only work, a failed attempt, or a session
without repository changes.

Base instructions require the changelog update before the final response.
Supported hooks can remind the agent. The CLI creates and preserves the file,
but it never writes session entries.

## Failure behavior

One harness failure does not stop independent harnesses or stages. Wagglebot
continues safe work and prints one final summary.

Return a failure code for:

- A company cache refresh failure, including a run that used stale cache.
- An invalid company configuration or catalog.
- A failed required write.
- A malformed target that cannot be preserved safely.
- A required installer or pinned runtime failure.

Return success with warnings for:

- A missing catalog.
- An unknown engineer.
- A missing credential value when a safe reference was written.
- An unsupported harness feature.
- An MCP entry skipped because its credential or transport cannot be expressed
  safely.

The summary names each successful, updated, skipped, warned, and failed item.

## Testing and CI

GitHub Actions can install normal npm dependencies from the npm registry. After
installation, the test phase uses local fixtures and makes no network request.

`test-app/` is the complete marked company repository fixture and drift gate.
CI performs this flow:

1. Create an isolated temporary home directory.
2. Run the real `wagglebot update` inside `test-app/`.
3. Verify the expected outputs for all nine harnesses.
4. Run the command again and verify idempotency.
5. Fail on an unexpected Git difference.

Cache and connection tests use a local Git remote. Skill and agent sources use
local fixture repositories. No test reads or changes the real home directory.

Automated coverage must include:

- Global and project instructions for all harnesses.
- Skills and custom agents for each compatible harness.
- Equivalent hooks for each compatible harness.
- Every supported MCP transport and credential representation.
- Safe skips for unsupported features.
- Missing, unknown, and invalid catalog cases.
- Missing credential values.
- Preservation of personal content.
- Destructive overwrite behavior.
- Partial harness failures and final exit codes.
- Project memory and changelog initialization and preservation.
- Company marker detection, explicit cached mode, and working-tree mode.
- Company repository URL precedence and reserved `.example` handling.
- First clone, cache refresh, invalid candidate, and stale-cache behavior.
- Pinned runtime installation and execution.

Tests never invoke an LLM. Linux CI covers the filesystem and shell behavior
used inside WSL. Native Windows tests are out of scope.

## Documentation changes

Implementation must update:

- The root README and Phase 1 status.
- CLI help and package README.
- The harness reference with nine verified adapters.
- Company and project onboarding instructions.
- The command migration notes.
- `test-app/` and its drift instructions.

## Out of scope

Phase 1 does not include:

- Any Wagglebot service.
- The Devin cloud agent.
- Shared or remote memory.
- Repository Brain search.
- Native Windows support.
- Automatic execution during dependency installation.
- Automatic backup for overwrite mode.
- Automatic creation of `catalog-info.yaml`.
- Harness selection or detection settings.
- Automatic team notifications about a release.

Teams announce reviewed company updates through their normal communication
channel. Engineers then run `wagglebot update --wagglebot` manually.
