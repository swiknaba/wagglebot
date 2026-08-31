import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyConfig } from "../registry";
import { createReporter } from "../report";
import { proxyToClaudeEntry, runWriteMcp } from "./write-mcp";

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
  runWriteMcp({ home, proxies: [remote], reporter: quiet() });
  const doc1 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc1.mcpServers.personal).toEqual({ command: "my-mcp" });
  expect(doc1.mcpServers.example.type).toBe("http");
  expect(JSON.stringify(doc1)).not.toContain("hunter2"); // never a secret value
  runWriteMcp({ home, proxies: [], reporter: quiet() }); // registry entry removed
  const doc2 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc2.mcpServers.example).toBeUndefined();
  expect(doc2.mcpServers.personal).toBeDefined();
});

test("second identical run reports ok", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  runWriteMcp({ home, proxies: [remote], reporter: quiet() });
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, proxies: [remote], reporter: r });
  expect(r.counts().updated).toBe(0);
  expect(r.counts().ok).toBe(1);
});
