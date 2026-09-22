# Harness Reference

Wagglebot provisions all nine local adapters on every company update. Tests
verify managed paths, formats, safe skips, and adapter identifiers offline.

| Harness | Global instructions | Skills | Custom agents | Hooks | MCP | Primary vendor source |
|---|---|---|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` Markdown | `claude-code` | `~/.claude/agents/` | `~/.claude/settings.json` JSON `PostToolUse` | `~/.claude.json` JSON | [Claude](https://code.claude.com/docs/en/settings) |
| OpenAI Codex | `~/.codex/AGENTS.md` Markdown | `codex` | Unsupported | Unsupported | `~/.codex/config.toml` TOML | [Codex](https://developers.openai.com/codex/config/) |
| JetBrains Junie | `~/.junie/AGENTS.md` Markdown | `junie` | `~/.junie/agents/` | Unsupported | `~/.junie/mcp/mcp.json` JSON | [Junie MCP settings](https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html) |
| Gemini CLI | `~/.gemini/GEMINI.md` Markdown | `gemini-cli` | `~/.gemini/agents/` | `~/.gemini/settings.json` JSON `AfterTool` | `~/.gemini/settings.json` JSON | [Gemini](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md) |
| GitHub Copilot | `~/.copilot/copilot-instructions.md` Markdown | `github-copilot` | `~/.copilot/agents/` | `~/.copilot/hooks/wagglebot.json` v1 JSON | `~/.copilot/mcp-config.json` JSON | [Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli) |
| Cline | `~/.cline/rules/wagglebot.md` Markdown | `cline` | Unsupported | Unsupported | `~/.cline/data/settings/cline_mcp_settings.json` JSON | [Cline](https://docs.cline.bot/getting-started/config) |
| Cursor | `~/.cursor/rules/wagglebot.mdc` MDC | `cursor` | `~/.cursor/agents/` | `~/.cursor/hooks.json` JSON `afterFileEdit` | `~/.cursor/mcp.json` JSON | [Cursor](https://docs.cursor.com/context/rules) |
| Devin Desktop | `~/.config/devin/AGENTS.md`; `~/.codeium/windsurf/memories/global_rules.md` Markdown | `devin`, `windsurf` | `~/.config/devin/agents/` | Devin CLI: `~/.config/devin/config.json` JSON `PostToolUse`; Cascade: `~/.codeium/windsurf/hooks.json` JSON `post_write_code` | Devin CLI: `~/.config/devin/mcp_config.json`; Cascade: `~/.codeium/windsurf/mcp_config.json` JSON | [Devin Local](https://docs.devin.ai/desktop/devin-local), [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli), [Devin MCP](https://docs.devin.ai/cli/extensibility/mcp/configuration), [Cascade hooks](https://docs.devin.ai/desktop/cascade/hooks) |
| Kiro | `~/.kiro/steering/AGENTS.md` Markdown | `kiro-cli` | `~/.kiro/agents/` | `~/.kiro/hooks/wagglebot.json` v1 JSON `PostFileSave` | `~/.kiro/settings/mcp.json` JSON | [Kiro MCP configuration](https://kiro.dev/docs/mcp/configuration/) |

Devin support is local Devin Desktop only. The Devin cloud agent is out of
scope. Devin Desktop includes both Devin CLI and Cascade targets.

Codex skips SSE, basic auth, and prefixed headers. Junie skips SSE and
credentialed entries. Copilot, Cline, and Cascade skip credentialed entries.
Gemini skips underscore names and commented JSON. An unset variable writes a
safe reference and warns.

Cursor and Cascade hook output delivery to the active agent is unverified.
Codex, Junie, and Cline receive durable rules through global instructions when
hooks are unsupported. `--overwrite-local` replaces only instructions, skills,
custom agents, hooks, and MCP categories. It creates no backup.

## Project targets

| Harnesses | Project target | Format |
|---|---|---|
| Claude Code | `CLAUDE.md` | Managed `@AGENTS.md` import |
| Gemini CLI | `GEMINI.md` | Managed `@./AGENTS.md` import |
| GitHub Copilot | `.github/copilot-instructions.md` | Managed Markdown block |
| OpenAI Codex, JetBrains Junie, Cline, Cursor, Devin Desktop, Kiro | `AGENTS.md` | Managed Markdown block, written once |

## Verified MCP details

Every JSON target owns the `mcpServers` parent key. Default mode preserves
foreign `mcpServers` entries. It replaces or removes only state-owned keys.
Codex owns a managed TOML `mcp_servers` block. Claude uses `type: "http"` or
`type: "sse"`. Gemini uses `httpUrl` for HTTP and `url` for SSE. Cline uses
`type: "streamableHttp"` for HTTP. Copilot uses `type: "local"`, `type: "http"`,
or `type: "sse"` and `tools: ["*"]`. Cursor uses `type: "stdio"` for local
entries. Devin CLI uses `transport: "http"` or `transport: "sse"` for remote
entries.

Codex writes `env_vars` for stdio only with the same-name restriction. The
environment-map key must equal the source variable name. Codex writes
`bearer_token_env_var` for HTTP bearer authentication. It writes
`env_http_headers` for compatible unprefixed headers.

The registry loader rejects a literal credential source before dialect handling.
Phase 1 skips file credential sources before dialect handling for every harness.
Claude and Gemini write `${VAR}`. Cursor and Devin CLI write `${env:NAME}`.
Kiro writes `${NAME}`. Codex writes environment variable names, not values.
Copilot, Cline, Junie, and Cascade skip credentialed entries because their
documented formats cannot safely represent the credential.
