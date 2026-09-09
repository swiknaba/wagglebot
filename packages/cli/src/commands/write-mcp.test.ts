import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "../harness";
import { HARNESSES } from "../harness";
import type { ProxyConfig } from "../registry";
import { loadRegistry } from "../registry";
import { createReporter } from "../report";
import { missingEnvVars, proxyToClaudeEntry, runWriteMcp } from "./write-mcp";

const quiet = () => createReporter(() => {}, false);
const remote: ProxyConfig = {
  namespace: "example",
  mode: "remote_http",
  endpoint: "https://mcp.example.com/mcp",
  auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "EXAMPLE_TOKEN" } },
};

test("maps a bearer remote to an http entry with an env expansion header", () => {
  expect(proxyToClaudeEntry(remote)).toEqual({
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
});

test("maps stdio_npx to a pinned npx command", () => {
  const p: ProxyConfig = {
    namespace: "gh",
    mode: "stdio_npx",
    command: "@example/mcp@1.4.2",
    args: ["--flag"],
    auth: { scheme: { kind: "env", map: { GH_TOKEN: "$SOURCE" } }, source: { from: "env", var: "MY_GH_TOKEN" } },
  };
  expect(proxyToClaudeEntry(p)).toEqual({
    command: "npx",
    args: ["-y", "@example/mcp@1.4.2", "--flag"],
    env: { GH_TOKEN: "${MY_GH_TOKEN}" },
  });
});

test("writes managed entries, preserves foreign entries, removes stale ones", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { personal: { command: "my-mcp" } } }));
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: quiet() });
  const doc1 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc1.mcpServers.personal).toEqual({ command: "my-mcp" });
  expect(doc1.mcpServers.example.type).toBe("http");
  expect(JSON.stringify(doc1)).not.toContain("hunter2"); // never a secret value
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [], env: {}, reporter: quiet() }); // registry entry removed
  const doc2 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc2.mcpServers.example).toBeUndefined();
  expect(doc2.mcpServers.personal).toBeDefined();
});

test("a corrupt target file reports failed and exits 1 without crashing", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  writeFileSync(join(home, ".claude.json"), "{ not valid json");
  const r = createReporter(() => {}, false);
  const code = runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
});

test("second identical run reports ok", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: quiet() });
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: r });
  expect(r.counts().updated).toBe(0);
  // One ok per harness that writes the bearer fixture: claude-code, codex, and gemini.
  expect(r.counts().ok).toBe(3);
});

test("an empty registry creates no file", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-mcp-"));
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [], env: {}, reporter: r });
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(r.counts().skipped).toBeGreaterThan(0);
});

test("reports every ${VAR} that is not set in the shell", () => {
  const proxies = loadRegistry(
    'proxies:\n  - namespace: a\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth: { scheme: { kind: bearer }, source: { from: env, var: A_TOKEN } }\n  - namespace: b\n    mode: stdio_cmd\n    command: run\n    env: { B_KEY: "${B_KEY}" }\n',
    "r.yaml",
  );
  expect(missingEnvVars(proxies, { A_TOKEN: "x" })).toEqual(["B_KEY"]);
});

test("a file credential source is reported once, not once per harness", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const claude = HARNESSES.find((h) => h.name === "claude-code");
  if (claude?.mcpTarget === undefined) throw new Error("fixture");
  const twice: Harness[] = [
    claude,
    { ...claude, name: "second", mcpTarget: { ...claude.mcpTarget, path: ".second.json" } },
  ];
  const fileSourced: ProxyConfig = {
    namespace: "vault",
    mode: "remote_http",
    endpoint: "https://v/mcp",
    auth: { scheme: { kind: "bearer" }, source: { from: "file", path: "/x" } },
  };
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  runWriteMcp({ home, harnesses: twice, proxies: [fileSourced], env: {}, reporter: r });
  expect(lines.filter((l) => l.includes("vault")).length).toBe(1);
});

const codexHarness = (): Harness => {
  const codex = HARNESSES.find((h) => h.name === "codex");
  if (codex?.mcpTarget === undefined) throw new Error("fixture");
  return codex;
};

test("a TOML target writes a managed block, keeps the text outside it, and reports ok twice", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-5"\n\n[mcp_servers.personal]\ncommand = "my-mcp"\n');
  runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: quiet() });
  const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(text).toContain('model = "gpt-5"');
  expect(text).toContain("[mcp_servers.personal]");
  expect(text).toContain("# wagglebot:begin");
  expect(text).toContain("[mcp_servers.example]");
  expect(text).toContain('bearer_token_env_var = "EXAMPLE_TOKEN"');
  expect(text).not.toContain("EXAMPLE_TOKEN}"); // the variable name, never an expansion or a value

  const second = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: second });
  expect(second.counts().ok).toBe(1);
  expect(second.counts().updated).toBe(0);
});

test("an emptied registry removes the TOML block and keeps the foreign table", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.personal]\ncommand = "my-mcp"\n');
  const first = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: first });
  expect(first.counts().updated).toBe(1);
  expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.example]");

  const emptied = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: [codex], proxies: [], env: {}, reporter: emptied });
  expect(emptied.counts().updated).toBe(1);
  const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(text).not.toContain("# wagglebot:begin");
  expect(text).not.toContain("[mcp_servers.example]");
  expect(text).toContain("[mcp_servers.personal]");
});

test("a namespace the TOML file already declares outside the block is failed and left out", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers."example"]\nurl = "https://mine/mcp"\n');
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  const code = runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(lines.join("\n")).toContain("example (codex)");
  expect(lines.join("\n")).toContain("already defined outside the wagglebot block in .codex/config.toml");
  const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(text).not.toContain("# wagglebot:begin");
  expect(text).toContain('url = "https://mine/mcp"');
});

test("a dialect skip is reported once per harness, and names the harness", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  const target = codex.mcpTarget;
  if (target === undefined || target.format !== "toml") throw new Error("fixture");
  const twice: Harness[] = [codex, { ...codex, name: "codex-2", mcpTarget: { ...target, path: ".codex/two.toml" } }];
  const sse: ProxyConfig = { ...remote, mode: "remote_sse" };
  const lines: string[] = [];
  runWriteMcp({
    home,
    harnesses: twice,
    proxies: [sse],
    env: {},
    reporter: createReporter((l) => lines.push(l), false),
  });
  const skips = lines.filter((l) => l.includes("Codex documents no SSE transport"));
  expect(skips).toHaveLength(2);
  expect(skips[0]).toContain("example (codex)");
  expect(skips[1]).toContain("example (codex-2)");
});

test("a harness that can write no entry says so, instead of blaming the registry", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  const onlySse: ProxyConfig = { ...remote, mode: "remote_sse" };
  const lines: string[] = [];
  runWriteMcp({
    home,
    harnesses: [codex],
    proxies: [onlySse],
    env: {},
    reporter: createReporter((l) => lines.push(l), false),
  });
  expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
  expect(lines.join("\n")).toContain(
    "no MCP server can be written for this harness — every entry was skipped above — file not created",
  );
  expect(lines.join("\n")).not.toContain("no MCP servers in the registry");
});
