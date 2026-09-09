---
name: adding-an-mcp-server
description: Use when an engineer adds, changes, or debugs an MCP server in a wagglebot registry.yaml, including its mode, auth scheme, credential variable, or version pin.
---

# Adding An MCP Server

## Overview

A `registry.yaml` file declares MCP servers for a company or a team. It
declares the server and the **name** of each credential. It never holds the
credential value (D10). `wagglebot update` reads the file and writes the MCP
config of every harness on the workstation.

## Step 1: Choose The Layer

| File | Applies to |
|---|---|
| `company/registry.yaml` | Every engineer |
| `teams/<team>/registry.yaml` | The members of Group `<team>` |

Wagglebot merges the two files. A team entry with the same `namespace` as a
company entry wins. Put a server in the team file when one team needs it.

## Step 2: Write The Entry

Every entry lives under the top-level `proxies` list.

| Field | Required | Allowed value |
|---|---|---|
| `namespace` | Yes | A unique name without whitespace |
| `mode` | Yes | `remote_http`, `remote_sse`, `stdio_npx`, or `stdio_cmd` |
| `endpoint` | For both remote modes | An absolute `http://` or `https://` URL |
| `command` | For both stdio modes | The npm package for `stdio_npx`, the program for `stdio_cmd` |
| `args` | No | A list of strings |
| `env` | No | A map of names to `"${VAR}"` expansions only |
| `auth.scheme.kind` | No | `none`, `bearer`, `header`, `basic`, or `env` |
| `auth.source` | With `auth.scheme` | `{ from: env, var: NAME }` |

A literal value in `env` fails the load. A shared registry never carries a
secret.

## Step 3: Match The Auth Scheme To The Transport

`auth.scheme` says how the server reads the credential. `auth.source` says
where wagglebot finds the value.

| `scheme.kind` | What wagglebot writes | Use it for |
|---|---|---|
| `none` | Nothing | A public server |
| `bearer` | The header `Authorization: Bearer ${VAR}` | A remote server |
| `header` | The header `name`, after the optional `prefix` | A remote server with a custom header |
| `basic` | The header `Authorization: Basic ${VAR}`. The scheme needs a `username` field. The variable must hold the base64 value of `username:password`, because the writer does not encode it. | A remote server with basic auth |
| `env` | One environment variable for each key of `map` | A stdio server |

The MCP specification tells a stdio server to read the environment, not an
OAuth header. Use `env` for `stdio_npx` and `stdio_cmd`. Wagglebot reads only
the **keys** of `map`, so write `"$SOURCE"` as the placeholder value.

`auth.source` accepts three values, and only one works today:

* `{ from: env, var: NAME }` — the supported source. The shell exports `NAME`.
* `{ from: literal, value: ... }` — **rejected at load time**. A literal value
  puts a secret into a reviewed, shared file, and every clone then holds it.
* `{ from: file, path: ... }` — reserved. The local hub of Phase 2 resolves a
  file source. Phase 1 has no hub, so use `env`.

## Step 4: Pin Every Executable

`stdio_npx` requires an exact package version, for example
`@example/mcp@1.4.2` (P31, D13). The loader rejects a range, a tag, and
`latest`. An unpinned package executes the next publish of a third party on
every workstation.

Wagglebot runs the command as `npx -y <command> <args...>`.

## Step 5: Place The Credential Value

1. Copy `.env.credentials.example` to `.env.credentials` in the company
   repository. The file is gitignored.
2. Add one line for each `${VAR}` that an entry names.
3. Open a new terminal. The wagglebot shell block exports the file.
4. Run `wagglebot update`.

`wagglebot update` reports each variable that no shell exports. It prints the
name and skips it. It never guesses a value.

## Complete Examples

A remote server with a bearer token:

```yaml
proxies:
  - namespace: sentry
    mode: remote_http
    endpoint: https://mcp.sentry.dev/mcp
    auth:
      scheme: { kind: bearer }
      source: { from: env, var: SENTRY_TOKEN }
```

A stdio server from a pinned npm package:

```yaml
proxies:
  - namespace: github
    mode: stdio_npx
    command: "@modelcontextprotocol/server-github@2026.8.4"
    args: ["--read-only"]
    env:
      GITHUB_HOST: "${GITHUB_HOST}"
    auth:
      scheme: { kind: env, map: { GITHUB_PERSONAL_ACCESS_TOKEN: "$SOURCE" } }
      source: { from: env, var: GITHUB_TOKEN }
```

## Review Is The Approval

A registry selects commands, endpoints, and credential names. A bad entry
therefore executes code and sends secrets away (P29). In Phase 1 the registry
lives in the company repository, so the pull request review is the control.
Name the upstream and the reason in the pull request description.

## Common Mistakes

| Mistake | Fix |
|---|---|
| A token pasted into `registry.yaml` | Name a `${VAR}` and put the value in `.env.credentials` |
| `command: "@example/mcp@latest"` | Pin an exact version, for example `@1.4.2` |
| A bearer header on a stdio server | Use `scheme: { kind: env, map: { ... } }` |
| `endpoint` without a scheme prefix | Write the absolute `https://` URL |
| Two entries with one `namespace` in one file | Rename one, or move it to the team layer |
| A new variable, and no new terminal | Open a new terminal, then run `wagglebot update` |
