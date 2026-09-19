import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, CallToolResultSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyConfig } from "@wagglebot/contracts";
import type { ResolvedCredential } from "../credentials";

export type McpToolSchema = ListToolsResult["tools"][number];

export type UpstreamClient = {
  initialize(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<McpToolSchema[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
};

export const HTTP_CONNECT_TIMEOUT_MS = 30_000;
export const HTTP_READ_TIMEOUT_MS = 300_000;
export const REMOVAL_GRACE_MS = 30_000;

function timedSignal(signal: AbortSignal, timeout: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
}

export class McpUpstreamClient implements UpstreamClient {
  readonly #client = new Client({ name: "wagglebot-mcp-hub", version: "0.0.0" });

  constructor(
    private readonly transport: Transport,
    private readonly connectTimeout = HTTP_CONNECT_TIMEOUT_MS,
  ) {}

  async initialize(signal: AbortSignal): Promise<void> {
    await this.#client.connect(this.transport, {
      signal: timedSignal(signal, this.connectTimeout),
      timeout: this.connectTimeout,
    });
  }

  async listTools(signal: AbortSignal): Promise<McpToolSchema[]> {
    const result = await this.#client.listTools(undefined, { signal, timeout: HTTP_READ_TIMEOUT_MS });
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const result = await this.#client.callTool({ name, arguments: args }, CallToolResultSchema, {
      signal,
      timeout: HTTP_READ_TIMEOUT_MS,
    });
    const parsed = CallToolResultSchema.safeParse(result);
    if (!parsed.success) throw new Error("upstream returned a non-standard tool result");
    return parsed.data;
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}

type UpstreamManagerInput = {
  createRemoteClient: (proxy: ProxyConfig, credential: ResolvedCredential | null) => UpstreamClient;
  createStdioClient: (proxy: ProxyConfig) => UpstreamClient;
  removalGraceMs?: number;
};

function isRemote(proxy: ProxyConfig): boolean {
  return proxy.mode === "remote_http" || proxy.mode === "remote_sse";
}

export class UpstreamManager {
  readonly #stdioClients = new Map<string, Promise<UpstreamClient>>();
  readonly #removalGraceMs: number;

  public constructor(private readonly input: UpstreamManagerInput) {
    this.#removalGraceMs = input.removalGraceMs ?? REMOVAL_GRACE_MS;
  }

  public async withClient<T>(
    proxy: ProxyConfig,
    credential: ResolvedCredential | null,
    signal: AbortSignal,
    operation: (client: UpstreamClient) => Promise<T>,
  ): Promise<T> {
    if (!isRemote(proxy)) return operation(await this.stdioClient(proxy, signal));

    const client = this.input.createRemoteClient(proxy, credential);
    try {
      await client.initialize(signal);
      return await operation(client);
    } finally {
      await client.close();
    }
  }

  public async drain(namespaces: Iterable<string>): Promise<void> {
    const clients = [...namespaces].flatMap((namespace) => {
      const client = this.#stdioClients.get(namespace);
      this.#stdioClients.delete(namespace);
      return client ? [client] : [];
    });
    if (clients.length === 0) return;
    if (this.#removalGraceMs > 0)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.#removalGraceMs);
      });
    await Promise.all(clients.map(async (client) => (await client).close()));
  }

  public close(): Promise<void> {
    return this.drain(this.#stdioClients.keys());
  }

  private stdioClient(proxy: ProxyConfig, signal: AbortSignal): Promise<UpstreamClient> {
    const existing = this.#stdioClients.get(proxy.namespace);
    if (existing) return existing;
    const client = this.input.createStdioClient(proxy);
    const starting = client.initialize(signal).then(
      () => client,
      async (error) => {
        this.#stdioClients.delete(proxy.namespace);
        await client.close();
        throw error;
      },
    );
    this.#stdioClients.set(proxy.namespace, starting);
    return starting;
  }
}
