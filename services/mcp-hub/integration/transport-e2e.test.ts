import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { type ProxyConfig, ProxyConfigSchema } from "@wagglebot/contracts";
import { z } from "zod";
import { loadHubConfig } from "../src/config";
import type { HubRuntimeOptions } from "../src/index";
import { createHubRuntime } from "../src/index";
import { TrustStore } from "../src/trust";

const hubBearer = "hub-secret-for-transport-fixture-only-123456789";
const upstreamCredential = "upstream-secret-for-transport-fixture-only";

type LocalRuntime = {
  runtime: Awaited<ReturnType<typeof createHubRuntime>>;
  cleanup(): void;
};

type SseUpstream = {
  authorizations: Array<string | null>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
};

function registry(proxies: ProxyConfig[]) {
  return JSON.stringify({
    schemaVersion: 1,
    revision: `reg_${"a".repeat(64)}`,
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-10-06T00:00:00.000Z",
    principal: { username: "alice" },
    proxies,
    toolCatalog: { version: 1, title: "Tools", platform_context: [], operating_principles: [], families: [] },
  });
}

async function localRuntime(
  proxies: ProxyConfig[],
  runtimeOptions: HubRuntimeOptions = {},
  path = process.env.PATH,
): Promise<LocalRuntime> {
  const directory = mkdtempSync(join("/tmp", "waggle-transport-e2e-"));
  try {
    const registryPath = join(directory, "registry.json");
    const trustPath = join(directory, "registry.trust.json");
    writeFileSync(registryPath, registry(proxies), { mode: 0o600 });
    chmodSync(registryPath, 0o600);
    const trust = new TrustStore(trustPath);
    await trust.load();
    for (const proxy of proxies) await trust.approve(proxy, ["credential", "origin", "command", "package"]);
    const env = {
      PATH: path,
      MCP_HUB_BEARER_TOKEN: hubBearer,
      MCP_HUB_AUTH_USERNAME: "private-user-sentinel",
      MCP_HUB_UPSTREAM_CREDENTIAL: upstreamCredential,
    };
    const config = loadHubConfig({
      ...env,
      MCP_HUB_CONFIG_PATH: registryPath,
      MCP_HUB_TRUST_PATH: trustPath,
    });
    const runtime = await createHubRuntime(config, { ...runtimeOptions, env, trustStore: trust });
    return { runtime, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function hubClient(runtime: LocalRuntime["runtime"]) {
  const transport = new StreamableHTTPClientTransport(new URL("http://hub.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${hubBearer}` } },
    fetch: (input, init) => runtime.app.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "hub-transport-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function sseUpstream(): Promise<SseUpstream> {
  const authorizations: Array<string | null> = [];
  const sessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>();
  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      authorizations.push(request.headers.authorization ?? null);
      if (request.method === "GET" && url.pathname === "/mcp") {
        const transport = new SSEServerTransport("/message", response);
        const server = new McpServer({ name: "sse-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.registerTool(
          "echo",
          { description: "SSE echo fixture", inputSchema: { value: z.string() } },
          async ({ value }) => ({ content: [{ type: "text", text: `sse:${value}` }] }),
        );
        sessions.set(transport.sessionId, { server, transport });
        await server.connect(transport);
        return;
      }
      if (request.method === "POST" && url.pathname === "/message") {
        const session = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (!session) {
          response.writeHead(404).end();
          return;
        }
        await session.transport.handlePostMessage(request, response);
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("SSE fixture failed to bind");

  return {
    authorizations,
    async fetch(input, init) {
      const target = new URL(input instanceof Request ? input.url : String(input));
      target.protocol = "http:";
      target.hostname = "127.0.0.1";
      target.port = String(address.port);
      return fetch(target, init);
    },
    async close() {
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
      sessions.clear();
      await closeHttpServer(http);
    },
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("real SSE upstream supports discovery, execution, and isolated credentials", async () => {
  const upstream = await sseUpstream();
  const proxy = ProxyConfigSchema.parse({
    namespace: "events",
    mode: "remote_sse",
    endpoint: "https://sse.example/mcp",
    auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "MCP_HUB_UPSTREAM_CREDENTIAL" } },
  });
  let setup: LocalRuntime | undefined;
  let client: Client | undefined;
  try {
    setup = await localRuntime([proxy], { upstreamFetch: upstream.fetch });
    client = await hubClient(setup.runtime);
    const advertised = await client.listTools();
    expect(advertised.tools.map(({ name }) => name)).toContain("execute");

    const found = await client.callTool({ name: "search", arguments: { query: "SSE echo fixture" } });
    expect(found.structuredContent).toMatchObject({ results: [{ tool: "events_echo", namespace: "events" }] });
    const executed = await client.callTool({
      name: "execute",
      arguments: { tool: "events_echo", arguments: { value: "through-sse" } },
    });
    expect(executed.structuredContent).toMatchObject({
      tool: "events_echo",
      namespace: "events",
      result: { content: [{ text: "sse:through-sse" }] },
    });
    expect(upstream.authorizations.length).toBeGreaterThan(0);
    expect(new Set(upstream.authorizations)).toEqual(new Set([`Bearer ${upstreamCredential}`]));
    expect(JSON.stringify(upstream.authorizations)).not.toContain(hubBearer);
  } finally {
    await client?.close();
    await setup?.runtime.close();
    await upstream.close();
    setup?.cleanup();
  }
}, 15_000);

test("pinned stdio_npx launches through npx with forwarded args and a safe child environment", async () => {
  const directory = mkdtempSync(join("/tmp", "waggle-npx-e2e-"));
  const binDirectory = join(directory, "bin");
  const npxPath = join(binDirectory, "npx");
  const invocationPath = join(directory, "npx-invocation.json");
  const packageName = "@fixture/mcp-server@1.2.3";
  const forwardedArgs = ["--fixture-mode", "forwarded-value"];
  const fixturePath = join(import.meta.dir, "stdio-fixture.mjs");
  const wrapper = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [installFlag, requestedPackage, ...args] = process.argv.slice(2);
if (installFlag !== "-y" || requestedPackage !== ${JSON.stringify(packageName)}) process.exit(71);
appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ installFlag, requestedPackage, args }));
const child = spawnSync(process.execPath, [${JSON.stringify(fixturePath)}, ...args], { stdio: "inherit", env: process.env });
if (child.error) process.exit(72);
process.exit(child.status ?? 73);
`;
  let setup: LocalRuntime | undefined;
  let client: Client | undefined;
  try {
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(npxPath, wrapper, { mode: 0o755 });
    chmodSync(npxPath, 0o755);
    const proxy = ProxyConfigSchema.parse({
      namespace: "npm",
      mode: "stdio_npx",
      command: packageName,
      args: forwardedArgs,
      env: { UPSTREAM_CREDENTIAL: "${MCP_HUB_UPSTREAM_CREDENTIAL}" },
    });
    const path = [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    setup = await localRuntime([proxy], {}, path);
    client = await hubClient(setup.runtime);

    const executed = await client.callTool({ name: "execute", arguments: { tool: "npm_environment", arguments: {} } });
    expect(executed.isError).not.toBe(true);
    const text = (executed.structuredContent as { result: { content: Array<{ text: string }> } }).result.content[0]
      ?.text;
    const childEnvironment = JSON.parse(text ?? "{}") as Record<string, unknown>;
    expect(childEnvironment).toEqual({
      home: "/tmp",
      user: "",
      hubBearer: undefined,
      authUsername: undefined,
      upstreamCredential,
    });
    expect(JSON.parse(await Bun.file(invocationPath).text())).toEqual({
      installFlag: "-y",
      requestedPackage: packageName,
      args: forwardedArgs,
    });
  } finally {
    await client?.close();
    await setup?.runtime.close();
    setup?.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
