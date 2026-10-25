import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryProposalRequest, RememberRequest } from "../../../packages/contracts/src/memory";
import { createMemoryMcpApp } from "./mcp";
import { ScannerUnavailableError } from "./scanner";
import { MemoryServiceError } from "./write-service";

const principal = {
  username: "alice",
  issuedAt: new Date("2026-10-18T10:00:00.000Z"),
  expiresAt: new Date("2026-10-18T11:00:00.000Z"),
  tokenId: "token-1",
  groups: [],
  orgOwner: false,
};

test("registers five strict memory tools and returns search prose only in structuredContent", async () => {
  const serviceCalls: unknown[] = [];
  const app = createMemoryMcpApp({
    resolvePrincipal: async () => principal,
    writeService: {
      remember: async (input: RememberRequest) => {
        serviceCalls.push(input);
        return { schemaVersion: 1, operationKey: "remember-1", outcomes: [] };
      },
      propose: async (input: MemoryProposalRequest) => {
        serviceCalls.push(input);
        const first = input.facts[0] as Record<string, unknown> | undefined;
        const scope = first?.scope as Record<string, unknown> | undefined;
        if (scope && scope.kind !== "system") throw new MemoryServiceError("agent_scope_forbidden", 403);
        if (first?.wake === true) throw new MemoryServiceError("agent_wake_forbidden", 403);
        return { schemaVersion: 1, operationKey: "proposal-1", outcomes: [] };
      },
      invalidate: async (_id: string, input: unknown) => {
        serviceCalls.push(input);
        return { schemaVersion: 1, operationKey: "forget-1", recordId: "x", status: "invalidated" };
      },
    } as never,
    searchService: {
      search: async (input: unknown) => {
        serviceCalls.push(input);
        return { schemaVersion: 1, prose: "record content" };
      },
      get: async (id: string) => ({ schemaVersion: 1, record: { id } }),
    } as never,
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://memory/mcp"), {
    requestInit: { headers: { authorization: "Bearer valid" } },
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "memory-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      "forget",
      "memory_query",
      "memory_search",
      "propose_memory",
      "remember",
    ]);
    const result = await client.callTool({
      name: "memory_search",
      arguments: { purpose: "wake", cascade: { system: "billing", includeOrg: true } },
    });
    expect(result.content).toEqual([]);
    expect(result.structuredContent).toEqual({ schemaVersion: 1, prose: "record content" });
    expect(serviceCalls[0]).toMatchObject({ schemaVersion: 1, purpose: "wake" });
    const forbidden = await client.callTool({
      name: "propose_memory",
      arguments: {
        operationKey: "proposal-1",
        facts: [{ scope: { kind: "domain", name: "commerce" }, wake: false }],
      },
    });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.structuredContent).toMatchObject({ error: { code: "agent_scope_forbidden" } });
    const invalid = await client.callTool({
      name: "forget",
      arguments: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        operationKey: "x",
        reason: "clean",
        unknown: "secret-input",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: "memory_invalid" } });
    expect(JSON.stringify(invalid)).not.toContain("secret-input");
    expect(serviceCalls).toHaveLength(1);

    const badProposal = await client.callTool({
      name: "propose_memory",
      arguments: {
        operationKey: "proposal-2",
        facts: [{ scope: { kind: "domain", name: "commerce" }, unexpected: "private" }],
      },
    });
    expect(badProposal.isError).toBe(true);
    expect(badProposal.structuredContent).toMatchObject({ error: { code: "agent_scope_forbidden" } });
    expect(JSON.stringify(badProposal)).not.toContain("private");

    const rawError = new Error("database path /private/secret");
    Object.assign(rawError, { code: "PG23505-sensitive" });
    const failing = createMemoryMcpApp({
      resolvePrincipal: async () => principal,
      writeService: {
        remember: async () => {
          throw rawError;
        },
        propose: async () => {
          throw rawError;
        },
        invalidate: async () => {
          throw rawError;
        },
      },
      searchService: {
        search: async () => {
          throw rawError;
        },
        get: async () => {
          throw rawError;
        },
      },
    });
    const failedTransport = new StreamableHTTPClientTransport(new URL("http://memory/mcp"), {
      requestInit: { headers: { authorization: "Bearer valid" } },
      fetch: (input, init) => failing.fetch(new Request(input, init)),
    });
    const failedClient = new Client({ name: "memory-failure-test", version: "1.0.0" });
    await failedClient.connect(failedTransport);
    try {
      const failed = await failedClient.callTool({
        name: "memory_search",
        arguments: { purpose: "wake", cascade: { system: "billing", includeOrg: true } },
      });
      expect(failed.structuredContent).toMatchObject({ error: { code: "memory_unavailable", retryable: true } });
      expect(JSON.stringify(failed)).not.toContain("PG23505-sensitive");
      expect(JSON.stringify(failed)).not.toContain("/private/secret");
    } finally {
      await failedClient.close();
      await failing.close();
    }

    const scannerFailure = new ScannerUnavailableError();
    const scannerApp = createMemoryMcpApp({
      resolvePrincipal: async () => principal,
      writeService: {
        remember: async () => {
          throw scannerFailure;
        },
        propose: async () => {
          throw scannerFailure;
        },
        invalidate: async () => {
          throw scannerFailure;
        },
      },
      searchService: {
        search: async () => {
          throw scannerFailure;
        },
        get: async () => {
          throw scannerFailure;
        },
      },
    });
    const scannerTransport = new StreamableHTTPClientTransport(new URL("http://memory/mcp"), {
      requestInit: { headers: { authorization: "Bearer valid" } },
      fetch: (input, init) => scannerApp.fetch(new Request(input, init)),
    });
    const scannerClient = new Client({ name: "memory-scanner-error-test", version: "1.0.0" });
    await scannerClient.connect(scannerTransport);
    try {
      const scannerResult = await scannerClient.callTool({
        name: "memory_search",
        arguments: { purpose: "wake", cascade: { system: "billing", includeOrg: true } },
      });
      expect(scannerResult.structuredContent).toMatchObject({
        error: { code: "scanner_unavailable", retryable: true },
      });
      expect(JSON.stringify(scannerResult)).not.toContain("ScannerUnavailableError");
      expect(JSON.stringify(scannerResult)).not.toContain("scanner offline");
    } finally {
      await scannerClient.close();
      await scannerApp.close();
    }
  } finally {
    await client.close();
    await app.close();
  }
});

test("closing during a stalled request body aborts the active MCP request", async () => {
  const app = createMemoryMcpApp({
    resolvePrincipal: async () => principal,
    writeService: { remember: async () => ({}), propose: async () => ({}), invalidate: async () => ({}) },
    searchService: { search: async () => ({}), get: async () => ({}) },
  });
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start() {
      bodyStarted();
    },
  });
  const pending = app.fetch(
    new Request("http://memory/mcp", {
      method: "POST",
      headers: { authorization: "Bearer valid" },
      body,
      duplex: "half",
    } as RequestInit),
  );
  await started;
  await app.close();
  const response = await pending;
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("memory_unavailable");
});

test("closing during an active tool call returns a bounded retryable failure", async () => {
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const app = createMemoryMcpApp({
    resolvePrincipal: async () => principal,
    writeService: { remember: async () => ({}), propose: async () => ({}), invalidate: async () => ({}) },
    searchService: {
      search: async () => {
        handlerStarted();
        return new Promise(() => undefined);
      },
      get: async () => ({}),
    },
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://memory/mcp"), {
    requestInit: { headers: { authorization: "Bearer valid" } },
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "memory-stall-test", version: "1.0.0" });
  await client.connect(transport);
  const call = client.callTool({
    name: "memory_search",
    arguments: { purpose: "wake", cascade: { system: "billing", includeOrg: true } },
  });
  await started;
  await app.close();
  await expect(call).rejects.toThrow();
  await client.close();
});
