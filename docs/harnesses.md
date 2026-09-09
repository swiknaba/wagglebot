# Harness Reference

This page records what wagglebot writes into each agent harness, and why
wagglebot leaves some MCP servers out. Each row holds one vendor fact: the
config path, the file format, the field names, and the credential mechanism.
Edit this table and `packages/cli/src/harness.ts` together when a vendor
changes a path or a field. Every skip below protects a credential: wagglebot
writes `${VAR}` or the name of an environment variable, never a secret (F23).

## MCP config per harness

| Harness | Global path | Format | Parent key / table | stdio fields | Streamable HTTP fields | SSE fields | `${VAR}` expansion | Credential mechanism wagglebot uses | Verified |
|---|---|---|---|---|---|---|---|---|---|
| claude-code | `~/.claude.json` | JSON | `mcpServers` | `command`, `args`, `env` | `type: "http"`, `url`, `headers` | `type: "sse"`, `url`, `headers` | Yes, `${VAR}` | `${VAR}` in `headers` and `env` | 2026-09-09 |
| codex | `~/.codex/config.toml` | TOML | `[mcp_servers.<id>]` | `command`, `args`, `env_vars` (names to forward), `env` (literal sub-table, never written), `cwd` | `url`, `bearer_token_env_var`, `env_http_headers` (header name → env var name), `http_headers` (static, never written) | Not documented — skipped | None documented | `bearer_token_env_var` for a bearer scheme; `env_http_headers` for a header scheme without prefix; `env_vars` for a stdio env var whose key equals the source var | 2026-09-09 |
| gemini | `~/.gemini/settings.json` | JSON | `mcpServers` (top level) | `command`, `args`, `env`, `cwd` | `httpUrl`, `headers` | `url`, `headers` | Yes, `$VAR`, `${VAR}`, `${VAR:-default}` | `${VAR}` in `headers` and `env`. A server name with `_` is skipped: the policy engine mis-parses it | 2026-09-09 |
| copilot | `~/.copilot/mcp-config.json` | JSON | `mcpServers` | `type: "local"`, `command`, `args`, `env`, `tools` | `type: "http"`, `url`, `headers`, `tools` | `type: "sse"`, `url`, `headers`, `tools` | None documented | None — an entry that needs a credential is skipped. `tools: ["*"]` is always written (vendor example) | 2026-09-09 |
| cline | `~/.cline/data/settings/cline_mcp_settings.json` | JSON | `mcpServers` | `command`, `args`, `env`, `disabled`, `autoApprove`, `timeout` (seconds) | `type: "streamableHttp"`, `url`, `headers` | `type: "sse"`, `url`, `headers` | None documented | None — an entry that needs a credential is skipped. Do not write `~/.cline/mcp.json`: the docs name it, the code never reads it (cline/cline#11671) | 2026-09-09 |
| junie | `~/.junie/mcp/mcp.json` | JSON | `mcpServers` | `command`, `args`, `env` | `url`, `headers` (no `type`) | Not documented — skipped | None documented | None — an entry that needs a credential is skipped | 2026-09-09 |

Sources:

* Codex — <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>,
  <https://learn.chatgpt.com/docs/config-file/config-reference>
* Gemini —
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md>,
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>
* Copilot —
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
* Cline — <https://docs.cline.bot/getting-started/config>,
  `sdk/packages/shared/src/storage/paths.ts` (`resolveMcpSettingsPath`),
  <https://github.com/cline/cline/issues/11671>
* Junie — <https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html>

## Three traps

1. Codex is the only TOML target. It spells the table `mcp_servers`, with an
   underscore.
2. Gemini splits the URL field by transport. Streamable HTTP uses `httpUrl`.
   SSE uses `url`. Every other harness uses `url` for both.
3. The public Cline documentation points at `~/.cline/mcp.json`. The Cline code
   never reads that file. Write the `data/settings/` path.

## Skipped entries

Each line below is a report line of `wagglebot write-mcp`. The entry stays out
of the file until an engineer applies the fix.

* `file credential source arrives with the Phase 2 hub` — the registry entry
  reads its credential from a file. Change the source to `from: env` until the
  Phase 2 hub arrives.
* `Gemini CLI mis-parses a server name with an underscore — rename the registry
  entry` — rename the namespace with a hyphen.
* `GitHub Copilot CLI does not expand ${VAR} in mcp-config.json — the credential
  would land as a literal, so the entry is left out` — no fix inside wagglebot.
  Add the server by hand outside the managed keys, or wait for vendor support.
* `Cline does not expand ${VAR} in cline_mcp_settings.json — the credential
  would land as a literal, so the entry is left out` — the same answer as
  Copilot.
* `Junie does not expand ${VAR} in mcp.json — the credential would land as a
  literal, so the entry is left out` — the same answer as Copilot.
* `Junie documents no SSE transport` — declare the server as `remote_http` when
  the vendor offers streamable HTTP.
* `Codex documents no SSE transport` — the same answer as Junie.
* `Codex sets a header from an env var without a prefix — drop the prefix or use
  a bearer scheme` — remove `auth.scheme.prefix`, or use `kind: bearer`.
* `Codex has no env-var mechanism for basic auth` — use a bearer scheme or a
  header scheme.
* `Codex expresses a credential as an environment variable name — this proxy
  names another source` — the entry reads its credential from a file. Change
  `auth.source` to `from: env`.
* `Codex forwards an environment variable under its own name only (env_vars) —
  the registry names ${SOURCE} for KEY; rename one so they match` — give the
  `auth.scheme.map` key the same name as `auth.source.var`.
* `already defined outside the wagglebot block in .codex/config.toml — remove it
  there, or rename the registry entry` — the file already declares that server
  table. Delete the personal table, or rename the registry namespace.

## The TOML block

Codex owns `~/.codex/config.toml`, so wagglebot writes one managed block into
it:

```toml
# wagglebot:begin
[mcp_servers.example]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"
# wagglebot:end
```

The block sits at the end of the file. TOML gives every key after a table
header to that table. A key that a person appends below the block therefore
lands in the last wagglebot table. Put personal tables and personal keys above
the block.

## Add a harness

1. Add the entry to `HARNESSES` in `packages/cli/src/harness.ts`, with the
   vendor source URL in a comment.
2. Add a dialect to `packages/cli/src/mcp-dialects.ts` when the fields differ
   from an existing one.
3. Add one test per mode in `packages/cli/src/mcp-dialects.test.ts`.
4. Add the row to the table above.
