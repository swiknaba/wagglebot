import { expect, test } from "bun:test";
import { needsExpansion, proxyToClaudeEntry, renderEntry, renderTomlTables } from "./mcp-dialects";
import type { ProxyConfig } from "./registry";

const remote: ProxyConfig = {
  namespace: "example",
  mode: "remote_http",
  endpoint: "https://mcp.example.com/mcp",
  auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "EXAMPLE_TOKEN" } },
};
const sse: ProxyConfig = { ...remote, mode: "remote_sse" };
const stdioNpx: ProxyConfig = {
  namespace: "gh",
  mode: "stdio_npx",
  command: "@example/mcp@1.4.2",
  args: ["--flag"],
  auth: { scheme: { kind: "env", map: { GH_TOKEN: "$SOURCE" } }, source: { from: "env", var: "MY_GH_TOKEN" } },
};
// The same server, with the map key equal to the source var. Codex forwards this one.
const stdioSameName: ProxyConfig = {
  ...stdioNpx,
  auth: { scheme: { kind: "env", map: { GH_TOKEN: "$SOURCE" } }, source: { from: "env", var: "GH_TOKEN" } },
};
const plainRemote: ProxyConfig = { namespace: "plain", mode: "remote_http", endpoint: "https://plain.example/mcp" };
const plainStdio: ProxyConfig = { namespace: "plain-cmd", mode: "stdio_cmd", command: "my-mcp", args: ["--x"] };

const entryOf = (rendered: ReturnType<typeof renderEntry>): Record<string, unknown> => {
  if (!rendered.ok) throw new Error(`expected an entry, got: ${rendered.reason}`);
  return rendered.entry;
};
const reasonOf = (rendered: ReturnType<typeof renderEntry>): string => {
  if (rendered.ok) throw new Error("expected a skip");
  return rendered.reason;
};

test("claude renders http, sse, and stdio, and proxyToClaudeEntry agrees", () => {
  expect(entryOf(renderEntry("claude", remote))).toEqual({
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
  expect(entryOf(renderEntry("claude", sse))).toEqual({
    type: "sse",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
  expect(entryOf(renderEntry("claude", stdioNpx))).toEqual({
    command: "npx",
    args: ["-y", "@example/mcp@1.4.2", "--flag"],
    env: { GH_TOKEN: "${MY_GH_TOKEN}" },
  });
  expect(proxyToClaudeEntry(remote)).toEqual(entryOf(renderEntry("claude", remote)));
});

test("claude omits an empty headers or env key", () => {
  expect(entryOf(renderEntry("claude", plainRemote))).toEqual({ type: "http", url: "https://plain.example/mcp" });
  expect(entryOf(renderEntry("claude", plainStdio))).toEqual({ command: "my-mcp", args: ["--x"] });
});

test("codex names the bearer env var instead of a header value", () => {
  expect(entryOf(renderEntry("codex", remote))).toEqual({
    url: "https://mcp.example.com/mcp",
    bearer_token_env_var: "EXAMPLE_TOKEN",
  });
});

test("codex maps a prefix-free header scheme to env_http_headers", () => {
  const header: ProxyConfig = {
    ...remote,
    auth: { scheme: { kind: "header", name: "X-Api-Key" }, source: { from: "env", var: "API_KEY" } },
  };
  expect(entryOf(renderEntry("codex", header))).toEqual({
    url: "https://mcp.example.com/mcp",
    env_http_headers: { "X-Api-Key": "API_KEY" },
  });
});

test("codex skips a header with a prefix, basic auth, and sse", () => {
  const prefixed: ProxyConfig = {
    ...remote,
    auth: {
      scheme: { kind: "header", name: "X-Api-Key", prefix: "Token " },
      source: { from: "env", var: "API_KEY" },
    },
  };
  expect(reasonOf(renderEntry("codex", prefixed))).toBe(
    "Codex sets a header from an env var without a prefix — drop the prefix or use a bearer scheme",
  );
  const basic: ProxyConfig = {
    ...remote,
    auth: { scheme: { kind: "basic", username: "bee" }, source: { from: "env", var: "API_KEY" } },
  };
  expect(reasonOf(renderEntry("codex", basic))).toBe("Codex has no env-var mechanism for basic auth");
  expect(reasonOf(renderEntry("codex", sse))).toBe("Codex documents no SSE transport");
});

test("codex writes a bare url for a remote proxy with no auth", () => {
  expect(entryOf(renderEntry("codex", plainRemote))).toEqual({ url: "https://plain.example/mcp" });
});

test("codex forwards a stdio env var under its own name only", () => {
  expect(entryOf(renderEntry("codex", stdioSameName))).toEqual({
    command: "npx",
    args: ["-y", "@example/mcp@1.4.2", "--flag"],
    env_vars: ["GH_TOKEN"],
  });
  expect(reasonOf(renderEntry("codex", stdioNpx))).toBe(
    "Codex forwards an environment variable under its own name only (env_vars) — the registry names ${MY_GH_TOKEN} for GH_TOKEN; rename one so they match",
  );
  expect(entryOf(renderEntry("codex", plainStdio))).toEqual({ command: "my-mcp", args: ["--x"] });
});

test("renderTomlTables writes one table per server, in namespace order", () => {
  const entries = [
    { namespace: "gh", entry: entryOf(renderEntry("codex", stdioSameName)) },
    { namespace: "example", entry: entryOf(renderEntry("codex", remote)) },
  ];
  expect(renderTomlTables("mcp_servers", entries)).toBe(
    [
      "[mcp_servers.example]",
      'url = "https://mcp.example.com/mcp"',
      'bearer_token_env_var = "EXAMPLE_TOKEN"',
      "",
      "[mcp_servers.gh]",
      'command = "npx"',
      'args = ["-y", "@example/mcp@1.4.2", "--flag"]',
      'env_vars = ["GH_TOKEN"]',
    ].join("\n"),
  );
});

test("renderTomlTables quotes a namespace that is not a bare key, and a header map", () => {
  const entry = { url: "https://x/mcp", env_http_headers: { "X-Api-Key": "API_KEY" } };
  expect(renderTomlTables("mcp_servers", [{ namespace: "team.ops", entry }])).toBe(
    ['[mcp_servers."team.ops"]', 'url = "https://x/mcp"', 'env_http_headers = { "X-Api-Key" = "API_KEY" }'].join("\n"),
  );
});

test("needsExpansion is true only when a ${VAR} must reach the file", () => {
  expect(needsExpansion(plainRemote)).toBe(false);
  expect(needsExpansion(plainStdio)).toBe(false);
  expect(needsExpansion(remote)).toBe(true);
  expect(needsExpansion({ ...plainStdio, env: { API_KEY: "${API_KEY}" } })).toBe(true);
});

test("codex skips a credential source that is not an environment variable", () => {
  const fileSourced: ProxyConfig = {
    ...remote,
    auth: { scheme: { kind: "bearer" }, source: { from: "file", path: "/x" } },
  };
  expect(reasonOf(renderEntry("codex", fileSourced))).toBe(
    "Codex expresses a credential as an environment variable name — this proxy names another source",
  );
});

test("renderTomlTables refuses a key that no dialect declares", () => {
  expect(() => renderTomlTables("mcp_servers", [{ namespace: "x", entry: { bogus: "1" } }])).toThrow(
    'renderTomlTables: unknown key "bogus" — add it to TOML_KEY_ORDER',
  );
});

test("needsExpansion sees a ${VAR} inside the command or the args", () => {
  expect(needsExpansion({ ...plainStdio, args: ["--token=${SECRET}"] })).toBe(true);
  expect(needsExpansion({ ...plainStdio, command: "${HOME}/bin/mcp" })).toBe(true);
});

test("gemini splits the url field by transport and keeps the ${VAR} headers", () => {
  expect(entryOf(renderEntry("gemini", remote))).toEqual({
    httpUrl: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
  expect(entryOf(renderEntry("gemini", sse))).toEqual({
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
  expect(entryOf(renderEntry("gemini", stdioNpx))).toEqual({
    command: "npx",
    args: ["-y", "@example/mcp@1.4.2", "--flag"],
    env: { GH_TOKEN: "${MY_GH_TOKEN}" },
  });
  expect(entryOf(renderEntry("gemini", plainRemote))).toEqual({ httpUrl: "https://plain.example/mcp" });
});

test("gemini skips a server name that carries an underscore", () => {
  expect(reasonOf(renderEntry("gemini", { ...remote, namespace: "team_ops" }))).toBe(
    "Gemini CLI mis-parses a server name with an underscore — rename the registry entry",
  );
});

test("copilot writes tools: [*] and skips a proxy that needs a ${VAR}", () => {
  expect(entryOf(renderEntry("copilot", plainRemote))).toEqual({
    type: "http",
    url: "https://plain.example/mcp",
    tools: ["*"],
  });
  expect(entryOf(renderEntry("copilot", { ...plainRemote, mode: "remote_sse" }))).toEqual({
    type: "sse",
    url: "https://plain.example/mcp",
    tools: ["*"],
  });
  expect(entryOf(renderEntry("copilot", plainStdio))).toEqual({
    type: "local",
    command: "my-mcp",
    args: ["--x"],
    tools: ["*"],
  });
  const reason =
    "GitHub Copilot CLI does not expand ${VAR} in mcp-config.json — the credential would land as a literal, so the entry is left out";
  expect(reasonOf(renderEntry("copilot", remote))).toBe(reason);
  expect(reasonOf(renderEntry("copilot", sse))).toBe(reason);
  expect(reasonOf(renderEntry("copilot", stdioNpx))).toBe(reason);
});

test("cline names the streamable HTTP transport and skips a proxy that needs a ${VAR}", () => {
  expect(entryOf(renderEntry("cline", plainRemote))).toEqual({
    type: "streamableHttp",
    url: "https://plain.example/mcp",
  });
  expect(entryOf(renderEntry("cline", { ...plainRemote, mode: "remote_sse" }))).toEqual({
    type: "sse",
    url: "https://plain.example/mcp",
  });
  expect(entryOf(renderEntry("cline", plainStdio))).toEqual({ command: "my-mcp", args: ["--x"] });
  const reason =
    "Cline does not expand ${VAR} in cline_mcp_settings.json — the credential would land as a literal, so the entry is left out";
  expect(reasonOf(renderEntry("cline", remote))).toBe(reason);
  expect(reasonOf(renderEntry("cline", stdioNpx))).toBe(reason);
});
