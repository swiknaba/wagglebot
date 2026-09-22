# Phase 1 Onboarding

Phase 1 runs without a Wagglebot service on macOS, Linux, and WSL. Native Windows
shells, PowerShell, and cmd are unsupported.

## Engineer flow

```sh
npm install --global wagglebot@<version>
wagglebot connect <company-git-url>
wagglebot update --wagglebot
cd my-project
wagglebot init
wagglebot update
```

`connect` stores a company URL in `~/.wagglebot/config.json` without Git
credentials. It is optional when the company package has a real default URL.
The official `git@company.example:platform/mycompany-wagglebot.git` value is
reserved `.example` documentation data. It counts as unset and the CLI never fetches it.

Run `wagglebot update --wagglebot` after a reviewed company announcement. It
refreshes the private cache, validates the marker and exact package pin, and
provisions all compatible local targets. Engineers do not keep a visible company
clone. Project `init` and `update` need no company configuration or identity.

For cached mode, keep personal credentials in `~/.wagglebot/.env.credentials`.
Copy the active cache's `.env.credentials.example` to that path, then enter the required values.
Open a new terminal after `update --wagglebot` to load the file.
Cache refresh preserves this personal file outside its immutable revisions.

## Administrator flow

```sh
wagglebot init --wagglebot mycompany-wagglebot
cd mycompany-wagglebot
git init
npm install
wagglebot update
```

The scaffold writes `wagglebot.yaml`. Inside this marked repository, plain
`wagglebot update` uses uncommitted working-tree changes. Use this mode to test
a company change before publication.
`npm install` installs the exact package pin and its shell script.
In a working tree, keep personal credentials in the gitignored `.env.credentials` at the repository root.

The catalog is optional. A missing catalog or unknown engineer provisions the
company layer with a warning. An invalid catalog returns failure after safe
company-layer provisioning.

## Safety

Wagglebot never writes a credential value. It writes supported environment
variable references or skips one unsafe MCP entry. Run Wagglebot and each
harness inside the same WSL distribution.

Read the [harness reference](harnesses.md) and the
[command migration](phase-1-command-migration.md) before an upgrade.
