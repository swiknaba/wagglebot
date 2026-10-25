import { expect, test } from "bun:test";
import { ProxyConfigSchema } from "@wagglebot/contracts";
import { DiscoveryCache } from "../discovery/cache";
import { type UpstreamClient, UpstreamManager } from "../upstream/types";
import { buildHubCatalog } from "./catalog";
import { CodeMode } from "./tools";

test("search exposes bounded scored routing metadata with the requested namespace and limit", () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github", [
    { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
  ]);
  const unused = (): UpstreamClient => {
    throw new Error("search must not contact an upstream");
  };
  const mode = new CodeMode({
    catalog: () => buildHubCatalog(cache.states()),
    cache,
    proxies: () => [
      ProxyConfigSchema.parse({ namespace: "github", mode: "remote_http", endpoint: "https://github.example/mcp" }),
    ],
    upstreams: new UpstreamManager({ createRemoteClient: unused, createStdioClient: unused, removalGraceMs: 0 }),
  });

  expect(mode.search("repository issues", "github", 1)).toEqual({
    schemaVersion: 1,
    results: [{ tool: "github_list_issues", namespace: "github", description: "List repository issues", score: 2 }],
  });
});

test("getSchema returns one ready qualified tool and rejects unknown tools", () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github", [
    { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
  ]);
  const unused = (): UpstreamClient => {
    throw new Error("schema lookup must not contact an upstream");
  };
  const mode = new CodeMode({
    catalog: () => buildHubCatalog(cache.states()),
    cache,
    proxies: () => [],
    upstreams: new UpstreamManager({ createRemoteClient: unused, createStdioClient: unused, removalGraceMs: 0 }),
  });

  expect(mode.getSchema("github_list_issues")).toEqual({
    schemaVersion: 1,
    tool: "github_list_issues",
    namespace: "github",
    description: "List repository issues",
    inputSchema: { type: "object" },
  });
  expect(() => mode.getSchema("github_missing")).toThrow("hub_tool_unavailable");
});

test("execute routes one qualified ready tool without retrying it", async () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github", [
    { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
  ]);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = (): UpstreamClient => ({
    async initialize() {},
    async listTools() {
      return [];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  });
  const mode = new CodeMode({
    catalog: () => buildHubCatalog(cache.states()),
    cache,
    proxies: () => [
      ProxyConfigSchema.parse({ namespace: "github", mode: "remote_http", endpoint: "https://github.example/mcp" }),
    ],
    upstreams: new UpstreamManager({ createRemoteClient: client, createStdioClient: client, removalGraceMs: 0 }),
  });

  await expect(mode.execute("github_list_issues", { state: "open" }, new AbortController().signal)).resolves.toEqual({
    schemaVersion: 1,
    tool: "github_list_issues",
    namespace: "github",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  expect(calls).toEqual([{ name: "list_issues", args: { state: "open" } }]);
});

test("execute rejects non-object arguments before reaching an upstream", async () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github", [
    { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
  ]);
  const unused = (): UpstreamClient => {
    throw new Error("invalid arguments must not reach an upstream");
  };
  const mode = new CodeMode({
    catalog: () => buildHubCatalog(cache.states()),
    cache,
    proxies: () => [
      ProxyConfigSchema.parse({ namespace: "github", mode: "remote_http", endpoint: "https://github.example/mcp" }),
    ],
    upstreams: new UpstreamManager({ createRemoteClient: unused, createStdioClient: unused, removalGraceMs: 0 }),
  });

  await expect(mode.execute("github_list_issues", null, new AbortController().signal)).rejects.toThrow(
    "hub_invalid_request",
  );
});

test("ambiguous qualified names are unavailable for both schema lookup and execution", async () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("a_b", [{ name: "c", inputSchema: { type: "object" } }]);
  cache.succeed("a", [{ name: "b_c", inputSchema: { type: "object" } }]);
  const unused = (): UpstreamClient => {
    throw new Error("ambiguous tools must not execute");
  };
  const mode = new CodeMode({
    catalog: () => buildHubCatalog(cache.states()),
    cache,
    proxies: () => [
      ProxyConfigSchema.parse({ namespace: "a_b", mode: "remote_http", endpoint: "https://a-b.example/mcp" }),
      ProxyConfigSchema.parse({ namespace: "a", mode: "remote_http", endpoint: "https://a.example/mcp" }),
    ],
    upstreams: new UpstreamManager({ createRemoteClient: unused, createStdioClient: unused, removalGraceMs: 0 }),
  });

  expect(() => mode.getSchema("a_b_c")).toThrow("hub_tool_unavailable");
  await expect(mode.execute("a_b_c", {}, new AbortController().signal)).rejects.toThrow("hub_tool_unavailable");
});

test("rejects an oversized upstream execution result without retrying", async () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github", [{ name: "large_result", inputSchema: { type: "object" } }]);
  let calls = 0;
  const client = (): UpstreamClient => ({
    async initialize() {},
    async listTools() {
      return [];
    },
    async callTool() {
      calls += 1;
      return { content: [{ type: "text", text: "x".repeat(1_100_000) }] };
    },
    async close() {},
  });
  const mode = new CodeMode({
    catalog: () => buildHubCatalog(cache.states()),
    cache,
    proxies: () => [
      ProxyConfigSchema.parse({ namespace: "github", mode: "remote_http", endpoint: "https://github.example/mcp" }),
    ],
    upstreams: new UpstreamManager({ createRemoteClient: client, createStdioClient: client, removalGraceMs: 0 }),
  });

  await expect(mode.execute("github_large_result", {}, new AbortController().signal)).rejects.toThrow(
    "hub_response_too_large",
  );
  expect(calls).toBe(1);
});
