import { describe, expect, test } from "bun:test";
import { ProxyConfigSchema } from "@wagglebot/contracts";
import {
  createRemoteFetch,
  createRemoteHttpClient,
  HTTP_CONNECT_TIMEOUT_MS,
  HTTP_READ_TIMEOUT_MS,
} from "./remote-http";
import { buildStdioOptions, npxCommand, requireExecutable } from "./stdio";
import { type UpstreamClient, UpstreamManager } from "./types";

const remoteProxy = (auth?: unknown) =>
  ProxyConfigSchema.parse({
    namespace: "example",
    mode: "remote_http",
    endpoint: "https://mcp.example.com/mcp",
    ...(auth === undefined ? {} : { auth }),
  });

const stdioProxy = (command: string, mode: "stdio_npx" | "stdio_cmd" = "stdio_npx") =>
  ProxyConfigSchema.parse({ namespace: "example", mode, command, args: ["--safe"], env: { TOKEN: "${LOCAL_TOKEN}" } });

const credential = { value: "upstream-secret", fingerprint: "not-logged" };

async function requestHeaders(
  proxy: ReturnType<typeof remoteProxy>,
  options: { trustedOrigins?: readonly string[]; response?: Response; responses?: Response[] } = {},
): Promise<Headers> {
  let request: Request | undefined;
  const responses = [...(options.responses ?? [])];
  const upstreamFetch = createRemoteFetch(proxy, credential, {
    trustedOrigins: options.trustedOrigins,
    fetch: async (input, init) => {
      request = new Request(input, init);
      return responses.shift() ?? options.response ?? new Response("ok");
    },
  });
  await upstreamFetch("https://mcp.example.com/mcp", {
    headers: { Authorization: "Bearer hub-token", "X-Input": "ok" },
  });
  if (request === undefined) throw new Error("upstream fetch was not called");
  return request.headers;
}

function resultResponse(id: string | number | null): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "test-upstream", version: "1.0.0" },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function messageId(value: unknown): string | number | null | undefined {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
  const { id } = value;
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  throw new Error("MCP request id is invalid");
}

async function initializeHttpAdapter(): Promise<string | null> {
  let authorization: string | null = null;
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    authorization = request.headers.get("authorization");
    const id = messageId(await request.json());
    return id === undefined ? new Response(null, { status: 202 }) : resultResponse(id);
  };
  const proxy = remoteProxy({ scheme: { kind: "bearer" }, source: { from: "env", var: "TOKEN" } });
  const client = createRemoteHttpClient(proxy, credential, { fetch });
  await client.initialize(new AbortController().signal);
  await client.close();
  return authorization;
}

describe("remote upstream transport", () => {
  test("replaces inbound authorization with bearer credentials", async () => {
    const headers = await requestHeaders(
      remoteProxy({ scheme: { kind: "bearer" }, source: { from: "env", var: "TOKEN" } }),
    );
    expect(headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(headers.get("x-input")).toBe("ok");
  });

  test("formats header and basic credentials exactly", async () => {
    const headerHeaders = await requestHeaders(
      remoteProxy({
        scheme: { kind: "header", name: "X-API-Key", prefix: "Token " },
        source: { from: "env", var: "TOKEN" },
      }),
    );
    const basicHeaders = await requestHeaders(
      remoteProxy({ scheme: { kind: "basic", username: "alice" }, source: { from: "env", var: "TOKEN" } }),
    );
    expect(headerHeaders.get("x-api-key")).toBe("Token upstream-secret");
    expect(basicHeaders.get("authorization")).toBe(`Basic ${btoa("alice:upstream-secret")}`);
  });

  test("strips authorization when no upstream credential is configured", async () => {
    const headers = await requestHeaders(remoteProxy());
    expect(headers.has("authorization")).toBe(false);
  });

  test("rejects a cross-origin redirect unless the origin is explicitly trusted", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "https://other.example/mcp" } });
    await expect(
      requestHeaders(remoteProxy({ scheme: { kind: "bearer" }, source: { from: "env", var: "TOKEN" } }), {
        response: redirect,
      }),
    ).rejects.toThrow("untrusted redirect origin");
    const headers = await requestHeaders(
      remoteProxy({ scheme: { kind: "bearer" }, source: { from: "env", var: "TOKEN" } }),
      {
        trustedOrigins: ["https://other.example"],
        responses: [redirect, new Response("ok")],
      },
    );
    expect(headers.get("authorization")).toBe("Bearer upstream-secret");
  });

  test("uses the prescribed remote connection and read timeouts", () => {
    expect(HTTP_CONNECT_TIMEOUT_MS).toBe(30_000);
    expect(HTTP_READ_TIMEOUT_MS).toBe(300_000);
  });

  test("HTTP adapter connects through the SDK transport with only the upstream credential", async () => {
    expect(await initializeHttpAdapter()).toBe("Bearer upstream-secret");
  });
});

describe("stdio upstream transport", () => {
  test("accepts only an exact npx package version", () => {
    expect(npxCommand("@example/mcp@1.2.3", ["--safe"])).toEqual({
      command: "npx",
      args: ["-y", "@example/mcp@1.2.3", "--safe"],
    });
    expect(() => npxCommand("@example/mcp@latest", [])).toThrow("exact package version");
    expect(() => npxCommand("@example/mcp@^1.2.3", [])).toThrow("exact package version");
  });

  test("uses only the configured child environment", () => {
    const options = buildStdioOptions(stdioProxy("@example/mcp@1.2.3"), {
      LOCAL_TOKEN: "child-secret",
      PATH: "/parent",
    });
    expect(options.env).toEqual({ TOKEN: "child-secret" });
    expect(options.env?.PATH).toBeUndefined();
    expect(options.command).toBe("npx");
  });

  test("treats a missing configured stdio executable as fatal", async () => {
    await expect(requireExecutable("/definitely/not/a/mcp-server")).rejects.toThrow("stdio executable not found");
  });
});

function recordingClient(events: string[], label: string): UpstreamClient {
  return {
    async initialize() {
      events.push(`initialize:${label}`);
    },
    async listTools() {
      return [];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {
      events.push(`close:${label}`);
    },
  };
}

describe("upstream client lifecycle", () => {
  test("creates and closes a fresh remote client for every operation", async () => {
    const events: string[] = [];
    let created = 0;
    const manager = new UpstreamManager({
      createRemoteClient: () => recordingClient(events, `${++created}`),
      createStdioClient: () => recordingClient(events, "stdio"),
      removalGraceMs: 0,
    });
    const proxy = remoteProxy();
    const signal = new AbortController().signal;

    await manager.withClient(proxy, null, signal, (client) => client.listTools(signal));
    await manager.withClient(proxy, null, signal, (client) => client.listTools(signal));

    expect(events).toEqual(["initialize:1", "close:1", "initialize:2", "close:2"]);
  });

  test("reuses one stdio client and closes it after its namespace drains", async () => {
    const events: string[] = [];
    let created = 0;
    const manager = new UpstreamManager({
      createRemoteClient: () => recordingClient(events, "remote"),
      createStdioClient: () => recordingClient(events, `stdio-${++created}`),
      removalGraceMs: 0,
    });
    const proxy = stdioProxy("@example/mcp@1.2.3", "stdio_npx");
    const signal = new AbortController().signal;

    await manager.withClient(proxy, null, signal, (client) => client.listTools(signal));
    await manager.withClient(proxy, null, signal, (client) => client.listTools(signal));
    await manager.drain([proxy.namespace]);

    expect(events).toEqual(["initialize:stdio-1", "close:stdio-1"]);
  });
});
