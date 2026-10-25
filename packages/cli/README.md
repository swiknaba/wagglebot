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

## Project memory

Project `init` and `update`, along with `brain init`, use one memory-bundle
lifecycle. When no bundle exists, it creates `.agents/memory/index.md` and a
draft `.agents/memory/component.md`; it preserves existing concepts and
repairs derived indexes. Project commands also create `.agents/changelog.md`
when missing and preserve its content. The changelog stays separate and
unchanged. Keep one concept per Markdown file with YAML frontmatter;
only a non-empty `type` is required. Read the root index, edit concepts
directly, run `wagglebot update`, and commit concepts plus derived indexes for
Git review.

`wagglebot brain remember` previews by default and writes only with `--save`.
The legacy `.agents/memory.md` is rejected; Wagglebot does not read or migrate
it.

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

## Phase 2 operator commands (unreleased)

Configure `MEMORY_WORKER_URL` with the worker's HTTPS origin and load
`MEMORY_ADMIN_BEARER_TOKEN` from your operator secret environment. Explicit
loopback HTTP origins are allowed for local development. Credentials are not
accepted as command arguments. These commands print validated identifiers and
counts; they do not print source bodies or raw server errors.

```sh
wagglebot memory admin rescan --operation-key rescan-001
wagglebot memory admin reindex --operation-key reindex-001
wagglebot memory admin run-once --operation-key drain-001 --limit 20
```

Reuse an operation key to retry the same request. A new key starts a new
operation; use one to drain eligible failed work. `reindex --profile-id` may
explicitly select the fixed supported embedding profile. Database backup and
restore use the native Ruby operator tasks described in `deploy/README.md`;
they are not exposed by these commands or public HTTP endpoints.

From the marked company checkout root (including a company subdirectory),
publish one explicitly reviewed Markdown source:

```sh
wagglebot knowledge publish company/knowledge/api.md --repository company/config --revision HEAD --operation-key publish-api-001
```

The path is relative to that company root and is sent as a repository-relative
path. `--repository` must match a worker-configured trusted checkout identity.
The command reads committed source bytes at `--revision` (default `HEAD`),
preserves the Markdown body in deterministic chunks, and leaves working files
and Git untouched. For reliable retries, retain the resolved commit printed in
the successful response and reuse it with the same operation key.

To publish a reviewed deletion, select a commit where the source is absent and
retain its original scope/owner explicitly:

```sh
wagglebot knowledge publish company/knowledge/api.md --repository company/config --revision HEAD --operation-key remove-api-001 --remove --scope domain:payments --owner team-payments
```

The complete empty replacement invalidates the source's previous chunks.
Publication, admin recovery, model/scanner validation, context and Bridge work
must still pass the full Phase 2 release gate before release.

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
