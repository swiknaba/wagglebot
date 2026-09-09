import type { McpDialect } from "./harness";
import type { AuthScheme, CredentialSource, ProxyConfig } from "./registry";

// One MCP server entry, rendered for one harness dialect — or the reason this proxy cannot be
// expressed there without a literal credential in the file. A skip is honest. A secret is never
// written (F23).
export type Rendered = { ok: true; entry: Record<string, unknown> } | { ok: false; reason: string };

const expansion = (source: CredentialSource): string | undefined =>
  source.from === "env" ? `\${${source.var}}` : undefined;

const headersFor = (scheme: AuthScheme, source: CredentialSource): Record<string, string> | undefined => {
  const value = expansion(source);
  if (value === undefined) return undefined;
  if (scheme.kind === "bearer") return { Authorization: `Bearer ${value}` };
  if (scheme.kind === "header") return { [scheme.name]: `${scheme.prefix ?? ""}${value}` };
  if (scheme.kind === "basic") return { Authorization: `Basic ${value}` };
  return undefined;
};

// The environment of a stdio server: the registry env, plus the ${VAR} the auth scheme asks for
// under each name of its map.
const stdioEnv = (p: ProxyConfig): Record<string, string> => {
  const authEnv: Record<string, string> = {};
  if (p.auth !== undefined && p.auth.scheme.kind === "env") {
    const value = expansion(p.auth.source);
    if (value !== undefined) for (const key of Object.keys(p.auth.scheme.map)) authEnv[key] = value;
  }
  return { ...(p.env ?? {}), ...authEnv };
};

const stdioCommand = (p: ProxyConfig): { command: string; args: string[] } =>
  p.mode === "stdio_npx"
    ? { command: "npx", args: ["-y", p.command ?? "", ...(p.args ?? [])] }
    : { command: p.command ?? "", args: p.args ?? [] };

// True when this proxy reaches the file as a ${VAR}: an env credential source, or any env value.
// A harness that does not expand ${VAR} must skip such a proxy.
export function needsExpansion(p: ProxyConfig): boolean {
  if (p.auth?.source.from === "env") return true;
  if (Object.keys(p.env ?? {}).length > 0) return true;
  // A command or an argument can carry a placeholder too, for example "--token=${SECRET}".
  if (p.command?.includes("${") === true) return true;
  return (p.args ?? []).some((arg) => arg.includes("${"));
}

// Kept for the callers that render only the Claude Code shape. Equals renderEntry("claude", p).entry.
export function proxyToClaudeEntry(p: ProxyConfig): Record<string, unknown> {
  if (p.mode === "remote_http" || p.mode === "remote_sse") {
    const headers = p.auth === undefined ? undefined : headersFor(p.auth.scheme, p.auth.source);
    return {
      type: p.mode === "remote_http" ? "http" : "sse",
      url: p.endpoint,
      ...(headers === undefined ? {} : { headers }),
    };
  }
  const env = stdioEnv(p);
  return { ...stdioCommand(p), ...(Object.keys(env).length === 0 ? {} : { env }) };
}

// Codex names an environment variable instead of carrying a value, so every credential reaches
// the file as a variable name. A scheme with no such mechanism is skipped.
function codexEntry(p: ProxyConfig): Rendered {
  if (p.mode === "remote_sse") return { ok: false, reason: "Codex documents no SSE transport" };
  if (p.mode === "remote_http") return codexRemote(p);
  return codexStdio(p);
}

function codexRemote(p: ProxyConfig): Rendered {
  const url = p.endpoint;
  const auth = p.auth;
  // An env scheme names process environment variables, which a remote transport never reads.
  if (auth === undefined || auth.scheme.kind === "none" || auth.scheme.kind === "env")
    return { ok: true, entry: { url } };
  if (auth.source.from !== "env") {
    return {
      ok: false,
      reason: "Codex expresses a credential as an environment variable name — this proxy names another source",
    };
  }
  if (auth.scheme.kind === "bearer") return { ok: true, entry: { url, bearer_token_env_var: auth.source.var } };
  if (auth.scheme.kind === "basic") return { ok: false, reason: "Codex has no env-var mechanism for basic auth" };
  if ((auth.scheme.prefix ?? "") !== "") {
    return {
      ok: false,
      reason: "Codex sets a header from an env var without a prefix — drop the prefix or use a bearer scheme",
    };
  }
  return { ok: true, entry: { url, env_http_headers: { [auth.scheme.name]: auth.source.var } } };
}

function codexStdio(p: ProxyConfig): Rendered {
  const names: string[] = [];
  for (const [key, value] of Object.entries(stdioEnv(p))) {
    const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    if (variable !== key) {
      return {
        ok: false,
        reason: `Codex forwards an environment variable under its own name only (env_vars) — the registry names ${value} for ${key}. Rename one so they match`,
      };
    }
    names.push(key);
  }
  return { ok: true, entry: { ...stdioCommand(p), ...(names.length === 0 ? {} : { env_vars: names }) } };
}

// Gemini expands ${VAR}, so a credential travels as an expansion. It splits the URL field by
// transport: httpUrl for streamable HTTP, url for SSE.
function geminiEntry(p: ProxyConfig): Rendered {
  if (p.namespace.includes("_")) {
    return { ok: false, reason: "Gemini CLI mis-parses a server name with an underscore — rename the registry entry" };
  }
  if (p.mode === "remote_http" || p.mode === "remote_sse") {
    const headers = p.auth === undefined ? undefined : headersFor(p.auth.scheme, p.auth.source);
    const withHeaders = headers === undefined ? {} : { headers };
    const url = p.endpoint;
    return p.mode === "remote_http"
      ? { ok: true, entry: { httpUrl: url, ...withHeaders } }
      : { ok: true, entry: { url, ...withHeaders } };
  }
  const env = stdioEnv(p);
  return { ok: true, entry: { ...stdioCommand(p), ...(Object.keys(env).length === 0 ? {} : { env }) } };
}

// GitHub Copilot CLI documents no ${VAR} expansion, so a credentialed proxy is left out instead
// of written as a literal. Every entry carries the documented tools: ["*"].
function copilotEntry(p: ProxyConfig): Rendered {
  if (needsExpansion(p)) {
    return {
      ok: false,
      reason:
        "GitHub Copilot CLI does not expand ${VAR} in mcp-config.json — the credential would land as a literal, so the entry is left out",
    };
  }
  const tools = ["*"];
  if (p.mode === "remote_http") return { ok: true, entry: { type: "http", url: p.endpoint, tools } };
  if (p.mode === "remote_sse") return { ok: true, entry: { type: "sse", url: p.endpoint, tools } };
  return { ok: true, entry: { type: "local", ...stdioCommand(p), tools } };
}

// Cline documents no ${VAR} expansion either, and it names the streamable HTTP transport
// "streamableHttp".
function clineEntry(p: ProxyConfig): Rendered {
  if (needsExpansion(p)) {
    return {
      ok: false,
      reason:
        "Cline does not expand ${VAR} in cline_mcp_settings.json — the credential would land as a literal, so the entry is left out",
    };
  }
  if (p.mode === "remote_http") return { ok: true, entry: { type: "streamableHttp", url: p.endpoint } };
  if (p.mode === "remote_sse") return { ok: true, entry: { type: "sse", url: p.endpoint } };
  return { ok: true, entry: stdioCommand(p) };
}

// Junie documents no ${VAR} expansion and no SSE transport. Its remote entry carries the url
// alone, with no type field.
function junieEntry(p: ProxyConfig): Rendered {
  if (needsExpansion(p)) {
    return {
      ok: false,
      reason:
        "Junie does not expand ${VAR} in mcp.json — the credential would land as a literal, so the entry is left out",
    };
  }
  if (p.mode === "remote_sse") return { ok: false, reason: "Junie documents no SSE transport" };
  if (p.mode === "remote_http") return { ok: true, entry: { url: p.endpoint } };
  return { ok: true, entry: stdioCommand(p) };
}

export function renderEntry(dialect: McpDialect, p: ProxyConfig): Rendered {
  if (dialect === "codex") return codexEntry(p);
  if (dialect === "gemini") return geminiEntry(p);
  if (dialect === "copilot") return copilotEntry(p);
  if (dialect === "cline") return clineEntry(p);
  if (dialect === "junie") return junieEntry(p);
  return { ok: true, entry: proxyToClaudeEntry(p) };
}

// The order Codex documents for a server table. A key the dialect did not render is left out.
const TOML_KEY_ORDER = ["command", "args", "env_vars", "url", "bearer_token_env_var", "env_http_headers"];
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

// A TOML basic string accepts every escape JSON.stringify emits for a URL, a command, or a
// variable name, so one quoting rule covers each value the dialects produce.
const tomlValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (isStringList(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (isStringRecord(value)) {
    const pairs = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  throw new Error("mcp toml: a server entry carries a value that is not a string, a string list, or a string map");
};

// The content of the managed block of a TOML target: one [<table>.<namespace>] table per entry,
// in namespace order, separated by one blank line.
export function renderTomlTables(
  table: string,
  entries: { namespace: string; entry: Record<string, unknown> }[],
): string {
  return [...entries]
    .sort((a, b) => (a.namespace < b.namespace ? -1 : 1))
    .map(({ namespace, entry }) => {
      const key = BARE_KEY.test(namespace) ? namespace : JSON.stringify(namespace);
      for (const name of Object.keys(entry)) {
        if (!TOML_KEY_ORDER.includes(name)) {
          throw new Error(`renderTomlTables: unknown key "${name}" — add it to TOML_KEY_ORDER`);
        }
      }
      const lines = [`[${table}.${key}]`];
      for (const name of TOML_KEY_ORDER) {
        const value = entry[name];
        if (value !== undefined) lines.push(`${name} = ${tomlValue(value)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
