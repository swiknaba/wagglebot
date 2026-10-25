import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ProxyConfig, ProxyConfigSchema } from "@wagglebot/contracts";
import { loadHubConfig } from "../src/config";
import type { HubRuntimeOptions } from "../src/index";
import { createHubRuntime } from "../src/index";
import { TrustStore } from "../src/trust";

const hubBearer = "hub-secret-for-fixture-only-123456789";

type FakeUpstream = {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  authorizations: Array<string | null>;
};

async function fakeUpstream(toolName: string, resultText: string): Promise<FakeUpstream> {
  const authorizations: Array<string | null> = [];
  return {
    async fetch(request) {
      authorizations.push(request.headers.get("authorization"));
      const message = (await request.json()) as {
        id?: string | number | null;
        method?: string;
        params?: { arguments?: { value?: number } };
      };
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-upstream", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: toolName,
                    description: "Fixture tool",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "number" } },
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: `${resultText}:${message.params?.arguments?.value ?? "none"}` }] }
              : undefined;
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (result === undefined)
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
    async close() {},
    authorizations,
  };
}

function registry(proxies: ProxyConfig[], revision: string) {
  return JSON.stringify({
    schemaVersion: 1,
    revision: `reg_${revision.repeat(64)}`,
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-10-06T00:00:00.000Z",
    principal: { username: "alice" },
    proxies,
    toolCatalog: { version: 1, title: "Tools", platform_context: [], operating_principles: [], families: [] },
  });
}

async function localRuntime(
  proxies: ProxyConfig[],
  revision = "a",
  runtimeOptions: HubRuntimeOptions = {},
  extraEnv: Record<string, string> = {},
) {
  const directory = mkdtempSync(join("/tmp", "waggle-hub-e2e-"));
  const registryPath = join(directory, "registry.json");
  const trustPath = join(directory, "registry.trust.json");
  writeFileSync(registryPath, registry(proxies, revision), { mode: 0o600 });
  chmodSync(registryPath, 0o600);
  const trust = new TrustStore(trustPath);
  await trust.load();
  for (const proxy of proxies) await trust.approve(proxy, ["credential", "origin", "command", "package"]);
  const env = {
    PATH: process.env.PATH,
    MCP_HUB_BEARER_TOKEN: hubBearer,
    MCP_HUB_AUTH_USERNAME: "private-user-sentinel",
    MCP_HUB_UPSTREAM_CREDENTIAL: "upstream-secret-for-fixture-only",
    ...extraEnv,
  };
  const config = loadHubConfig({
    ...env,
    MCP_HUB_CONFIG_PATH: registryPath,
    MCP_HUB_TRUST_PATH: trustPath,
  });
  const runtime = await createHubRuntime(config, { ...runtimeOptions, env, trustStore: trust });
  return {
    directory,
    registryPath,
    trust,
    runtime,
    env,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function hubClient(runtime: Awaited<ReturnType<typeof createHubRuntime>>) {
  const transport = new StreamableHTTPClientTransport(new URL("http://hub.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${hubBearer}` } },
    fetch: (input, init) => runtime.app.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "hub-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("isolates remote credentials and swaps changed approved tools without stale exposure", async () => {
  const first = await fakeUpstream("oldTool", "old-result");
  const second = await fakeUpstream("newTool", "new-result");
  const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const request = new Request(`http://upstream${url.pathname}`, init);
    return (url.hostname === "first.example" ? first : second).fetch(request);
  };
  const firstProxy = ProxyConfigSchema.parse({
    namespace: "demo",
    mode: "remote_http",
    endpoint: "https://first.example/mcp",
    auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "MCP_HUB_UPSTREAM_CREDENTIAL" } },
  });
  const setup = await localRuntime([firstProxy], "a", { upstreamFetch });
  const runtime = setup.runtime;
  const client = await hubClient(runtime);
  try {
    const listing = await client.listTools();
    expect(listing.tools.map(({ name }) => name).sort()).toEqual([
      "execute",
      "get_schema",
      "get_tool_catalog",
      "get_usage_guide",
      "list_available_mcps",
      "recommend_tool_families",
      "search",
    ]);
    expect(first.authorizations.length).toBeGreaterThan(0);
    const oldTool = await client.callTool({
      name: "execute",
      arguments: { tool: "demo_oldTool", arguments: { value: 4 } },
    });
    expect(oldTool.structuredContent).toMatchObject({ schemaVersion: 1, tool: "demo_oldTool", namespace: "demo" });
    expect(first.authorizations.length).toBeGreaterThan(0);
    expect(new Set(first.authorizations)).toEqual(new Set(["Bearer upstream-secret-for-fixture-only"]));
    expect(JSON.stringify(first.authorizations)).not.toContain(hubBearer);

    const nextProxy = ProxyConfigSchema.parse({ ...firstProxy, endpoint: "https://second.example/mcp" });
    await setup.trust.approve(nextProxy, ["credential", "origin"]);
    writeFileSync(setup.registryPath, registry([nextProxy], "b"), { mode: 0o600 });
    chmodSync(setup.registryPath, 0o600);
    await runtime.refreshRegistry();
    const refreshed = await client.callTool({ name: "search", arguments: { query: "newTool" } });
    expect(refreshed.structuredContent).toMatchObject({ results: [{ tool: "demo_newTool", namespace: "demo" }] });
    const unavailable = await client.callTool({ name: "get_schema", arguments: { tool: "demo_oldTool" } });
    expect(unavailable.structuredContent).toMatchObject({ error: { code: "hub_tool_unavailable" } });
    expect(new Set(second.authorizations)).toEqual(new Set(["Bearer upstream-secret-for-fixture-only"]));
  } finally {
    await client.close();
    await runtime.close();
    await first.close();
    await second.close();
    setup.cleanup();
  }
});

test("stdio child sees only its configured credential and safe runtime environment", async () => {
  const proxy = ProxyConfigSchema.parse({
    namespace: "stdio",
    mode: "stdio_cmd",
    command: process.execPath,
    args: [join(import.meta.dir, "stdio-fixture.mjs")],
    env: { UPSTREAM_CREDENTIAL: "${MCP_HUB_UPSTREAM_CREDENTIAL}" },
  });
  const setup = await localRuntime([proxy]);
  const client = await hubClient(setup.runtime);
  try {
    const result = await client.callTool({ name: "execute", arguments: { tool: "stdio_environment", arguments: {} } });
    const text = (result.structuredContent as { result: { content: Array<{ text: string }> } }).result.content[0]?.text;
    const childEnvironment = JSON.parse(text ?? "{}") as Record<string, unknown>;
    expect(childEnvironment).toEqual({
      home: "/tmp",
      user: "",
      hubBearer: undefined,
      authUsername: undefined,
      upstreamCredential: "upstream-secret-for-fixture-only",
    });
  } finally {
    await client.close();
    await setup.runtime.close();
    setup.cleanup();
  }
}, 15_000);

test("a missing credential degrades only its namespace", async () => {
  const healthy = await fakeUpstream("listIssues", "healthy");
  let requestsToPrivate = 0;
  const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "private.example") {
      requestsToPrivate += 1;
      throw new Error("missing credentials should skip this namespace");
    }
    return healthy.fetch(new Request(`http://upstream${url.pathname}`, init));
  };
  const healthyProxy = ProxyConfigSchema.parse({
    namespace: "healthy",
    mode: "remote_http",
    endpoint: "https://healthy.example/mcp",
  });
  const privateProxy = ProxyConfigSchema.parse({
    namespace: "private",
    mode: "remote_http",
    endpoint: "https://private.example/mcp",
    auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "MISSING_UPSTREAM_CREDENTIAL" } },
  });
  const setup = await localRuntime([healthyProxy, privateProxy], "a", { upstreamFetch });
  const client = await hubClient(setup.runtime);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toContain("search");
    const available = await client.callTool({ name: "list_available_mcps", arguments: {} });
    expect(available.structuredContent).toMatchObject({
      namespaces: [{ namespace: "healthy", status: "ready", toolCount: 1 }],
    });
    const search = await client.callTool({ name: "search", arguments: { query: "listIssues" } });
    expect(search.structuredContent).toMatchObject({ results: [{ tool: "healthy_listIssues" }] });
    expect(requestsToPrivate).toBe(0);
  } finally {
    await client.close();
    await setup.runtime.close();
    await healthy.close();
    setup.cleanup();
  }
});

test("registry refresh aborts stale discovery before publishing a changed namespace", async () => {
  let notifyOldDiscovery: (() => void) | undefined;
  const oldStarted = new Promise<void>((resolve) => {
    notifyOldDiscovery = resolve;
  });
  const first = await fakeUpstream("oldTool", "old-result");
  const second = await fakeUpstream("newTool", "new-result");
  const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const request = new Request(`http://upstream${url.pathname}`, init);
    if (url.hostname === "first.example" && request.method === "POST") {
      const message = (await request.clone().json()) as { method?: string };
      if (message.method === "tools/list") {
        notifyOldDiscovery?.();
        return await new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) reject(new DOMException("aborted", "AbortError"));
          else
            request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
        });
      }
    }
    return (url.hostname === "first.example" ? first : second).fetch(request);
  };
  const oldProxy = ProxyConfigSchema.parse({
    namespace: "demo",
    mode: "remote_http",
    endpoint: "https://first.example/mcp",
  });
  const setup = await localRuntime(
    [oldProxy],
    "a",
    { upstreamFetch },
    {
      MCP_HUB_WARMUP_TOOLS: "0",
      MCP_HUB_TOOL_REFRESH_INTERVAL_SECONDS: "1",
    },
  );
  try {
    await oldStarted;
    const nextProxy = ProxyConfigSchema.parse({ ...oldProxy, endpoint: "https://second.example/mcp" });
    await setup.trust.approve(nextProxy, ["origin"]);
    writeFileSync(setup.registryPath, registry([nextProxy], "b"), { mode: 0o600 });
    chmodSync(setup.registryPath, 0o600);

    expect((await setup.runtime.refreshRegistry()).ok).toBe(true);
    const client = await hubClient(setup.runtime);
    try {
      const current = await client.callTool({ name: "search", arguments: { query: "newTool" } });
      const stale = await client.callTool({ name: "get_schema", arguments: { tool: "demo_oldTool" } });
      expect(current.structuredContent).toMatchObject({ results: [{ tool: "demo_newTool" }] });
      expect(stale.structuredContent).toMatchObject({ error: { code: "hub_tool_unavailable" } });
    } finally {
      await client.close();
    }
  } finally {
    await setup.runtime.close();
    await first.close();
    await second.close();
    setup.cleanup();
  }
});
