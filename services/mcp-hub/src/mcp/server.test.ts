import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHubApp } from "./server";

const token = "h".repeat(32);

function app(overrides: Record<string, unknown> = {}) {
  return createHubApp({
    bearerToken: token,
    ready: () => true,
    codeMode: {
      search: () => ({ schemaVersion: 1, results: [] }),
      getSchema: (tool: string) => ({
        schemaVersion: 1,
        tool,
        namespace: "demo",
        description: "Demo",
        inputSchema: {},
      }),
      execute: async (tool: string, args: unknown) => ({
        schemaVersion: 1,
        tool,
        namespace: "demo",
        result: { content: [{ type: "text", text: JSON.stringify(args) }] },
      }),
    } as never,
    introspection: {
      listAvailableMcps: () => ({ schemaVersion: 1, namespaces: [] }),
      getToolCatalog: () => ({ schemaVersion: 1, revision: "rev", markdown: "" }),
      recommendToolFamilies: () => ({ schemaVersion: 1, families: [] }),
      getUsageGuide: () => ({ schemaVersion: 1, markdown: "guide" }),
    } as never,
    ...overrides,
  });
}

test("authenticates before MCP transport and leaves only health routes public", async () => {
  const server = app();
  const missing = await server.fetch(new Request("http://hub/mcp", { method: "POST", body: "{}" }));
  const invalid = await server.fetch(
    new Request("http://hub/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer bad" } }),
  );
  expect(missing.status).toBe(401);
  expect((await missing.json()).error.code).toBe("hub_auth_required");
  expect(invalid.status).toBe(401);
  expect((await invalid.json()).error.code).toBe("hub_auth_invalid");
  expect((await server.fetch(new Request("http://hub/livez"))).status).toBe(200);
  expect((await server.fetch(new Request("http://hub/readyz"))).status).toBe(200);
});

test("registers exactly the seven hub tools and routes CodeMode calls", async () => {
  const server = app();
  const transport = new StreamableHTTPClientTransport(new URL("http://hub/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => server.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "hub-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "execute",
      "get_schema",
      "get_tool_catalog",
      "get_usage_guide",
      "list_available_mcps",
      "recommend_tool_families",
      "search",
    ]);
    const result = await client.callTool({
      name: "execute",
      arguments: { tool: "demo_ping", arguments: { value: 4 } },
    });
    expect(result.structuredContent).toMatchObject({ schemaVersion: 1, tool: "demo_ping", namespace: "demo" });
    expect(result.content).toEqual([]);
    const punctuationName = await client.callTool({
      name: "execute",
      arguments: { tool: "demo_tools__Ping", arguments: {} },
    });
    expect(punctuationName.structuredContent).toMatchObject({ tool: "demo_tools__Ping" });
    const routed = await Promise.all([
      client.callTool({ name: "search", arguments: { query: "demo" } }),
      client.callTool({ name: "get_schema", arguments: { tool: "demo_ping" } }),
      client.callTool({ name: "list_available_mcps", arguments: {} }),
      client.callTool({ name: "get_tool_catalog", arguments: {} }),
      client.callTool({ name: "recommend_tool_families", arguments: { task: "demo" } }),
      client.callTool({ name: "get_usage_guide", arguments: {} }),
    ]);
    expect(routed.map((response) => response.structuredContent)).toEqual([
      { schemaVersion: 1, results: [] },
      { schemaVersion: 1, tool: "demo_ping", namespace: "demo", description: "Demo", inputSchema: {} },
      { schemaVersion: 1, namespaces: [] },
      { schemaVersion: 1, revision: "rev", markdown: "" },
      { schemaVersion: 1, families: [] },
      { schemaVersion: 1, markdown: "guide" },
    ]);
    expect(routed.every((response) => Array.isArray(response.content) && response.content.length === 0)).toBe(true);
  } finally {
    await client.close();
  }
});

test("normalizes MCP input validation failures without echoing input details", async () => {
  const server = app();
  const transport = new StreamableHTTPClientTransport(new URL("http://hub/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => server.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "hub-validation-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "secret sentinel", private_argument_name: "do-not-echo" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ schemaVersion: 1, error: { code: "hub_invalid_request" } });
    expect(JSON.stringify(result)).not.toContain("private_argument_name");
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
  } finally {
    await client.close();
  }
});

test("rejects excessive tool input elements within the HTTP body limit before upstream execution", async () => {
  let executions = 0;
  const server = app({
    codeMode: {
      execute: async () => {
        executions += 1;
        return { schemaVersion: 1, result: {} };
      },
    } as never,
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://hub/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => server.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "hub-input-limit-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "execute",
      arguments: { tool: "demo_ping", arguments: { values: Array(10_001).fill(0) } },
    });
    expect(result.isError).toBe(true);
    expect(executions).toBe(0);
    const valid = await client.callTool({
      name: "execute",
      arguments: { tool: "demo_ping", arguments: { values: [1, 2, 3] } },
    });
    expect(valid.isError).not.toBe(true);
    expect(executions).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("rejects request bodies over 1 MiB without partial content", async () => {
  const server = app({
    codeMode: {
      execute: async () => ({
        schemaVersion: 1,
        tool: "demo_big",
        namespace: "demo",
        result: { data: "x".repeat(1_100_000) },
      }),
    } as never,
  });
  const oversized = await server.fetch(
    new Request("http://hub/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "x".repeat(1_100_000),
    }),
  );
  expect(oversized.status).toBe(413);
  expect((await oversized.json()).error.code).toBe("hub_response_too_large");
});

test("rejects a structured tool result over 1 MiB without partial content", async () => {
  const server = app({
    codeMode: {
      execute: async () => ({
        schemaVersion: 1,
        tool: "demo_big",
        namespace: "demo",
        result: { data: "x".repeat(1_100_000) },
      }),
    } as never,
  });
  let lastResponse: Response | undefined;
  const transport = new StreamableHTTPClientTransport(new URL("http://hub/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const response = await server.fetch(new Request(input, init));
      lastResponse = response.clone();
      return response;
    },
  });
  const client = new Client({ name: "hub-size-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    await expect(
      client.callTool({ name: "execute", arguments: { tool: "demo_big", arguments: {} } }),
    ).rejects.toThrow();
    if (!lastResponse) throw new Error("expected an oversized hub response");
    expect(lastResponse.status).toBe(413);
    expect((await lastResponse.json()).error.code).toBe("hub_response_too_large");
  } finally {
    await client.close();
  }
});

test("shutdown aborts active tool handlers and closes its MCP request", async () => {
  let entered = false;
  let activeSignal: AbortSignal | undefined;
  let notifyEntered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyEntered = resolve;
  });
  const server = app({
    codeMode: {
      execute: async (_tool: string, _args: unknown, signal: AbortSignal) => {
        entered = true;
        activeSignal = signal;
        notifyEntered?.();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      },
    } as never,
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://hub/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => server.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "hub-close-test", version: "1.0.0" });
  await client.connect(transport);
  const call = client
    .callTool({ name: "execute", arguments: { tool: "demo_ping", arguments: {} } })
    .catch(() => undefined);
  try {
    await started;
    await server.close();
    expect(entered).toBe(true);
    expect(activeSignal?.aborted).toBe(true);
    await call;
  } finally {
    await client.close();
    await server.close();
  }
});
