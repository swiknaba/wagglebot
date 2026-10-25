import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyConfig } from "@wagglebot/contracts";
import type { ResolvedCredential } from "../credentials";
import type { DiscoveryCache } from "../discovery/cache";
import type { UpstreamManager } from "../upstream/types";
import type { HubTool } from "./catalog";

type CodeModeOptions = {
  catalog: () => HubTool[];
  cache: DiscoveryCache;
  proxies: () => readonly ProxyConfig[];
  upstreams: UpstreamManager;
  credentialFor?: (proxy: ProxyConfig) => Promise<ResolvedCredential | null>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CodeMode {
  public constructor(private readonly options: CodeModeOptions) {}

  public search(
    query: string,
    namespace?: string,
    limit = 10,
  ): { schemaVersion: 1; results: Array<{ tool: string; namespace: string; description: string; score: number }> } {
    if ([...query].length < 1 || [...query].length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("hub_invalid_request");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new Error("hub_invalid_request");
    const results = this.options
      .catalog()
      .filter((tool) => namespace === undefined || tool.namespace === namespace)
      .map((tool) => ({
        tool,
        score: terms.filter((term) => `${tool.qualifiedName} ${tool.description}`.toLowerCase().includes(term)).length,
      }))
      .filter(({ score }) => score === terms.length)
      .sort(
        (left, right) => right.score - left.score || left.tool.qualifiedName.localeCompare(right.tool.qualifiedName),
      )
      .slice(0, limit)
      .map(({ tool, score }) => ({
        tool: tool.qualifiedName,
        namespace: tool.namespace,
        description: tool.description,
        score,
      }));
    return { schemaVersion: 1, results };
  }

  public getSchema(tool: string): {
    schemaVersion: 1;
    tool: string;
    namespace: string;
    description: string;
    inputSchema: Record<string, unknown>;
  } {
    const found = this.options.catalog().find((candidate) => candidate.qualifiedName === tool);
    if (!found) throw new Error("hub_tool_unavailable");
    return {
      schemaVersion: 1,
      tool: found.qualifiedName,
      namespace: found.namespace,
      description: found.description,
      inputSchema: structuredClone(found.inputSchema),
    };
  }

  public async execute(
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ schemaVersion: 1; tool: string; namespace: string; result: CallToolResult }> {
    if (!isObject(args)) throw new Error("hub_invalid_request");
    const found = this.options.catalog().find((candidate) => candidate.qualifiedName === tool);
    if (!found) throw new Error("hub_tool_unavailable");
    if (this.options.cache.state(found.namespace).status !== "ready") throw new Error("hub_namespace_unavailable");
    const proxy = this.options.proxies().find((candidate) => candidate.namespace === found.namespace);
    if (!proxy) throw new Error("hub_namespace_unavailable");
    const credential = this.options.credentialFor ? await this.options.credentialFor(proxy) : null;
    if (proxy.auth !== undefined && credential === null) throw new Error("hub_namespace_unavailable");
    const result = await this.options.upstreams.withClient(proxy, credential, signal, (client) =>
      client.callTool(found.localName, args, signal),
    );
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024 * 1024)
      throw new Error("hub_response_too_large");
    return { schemaVersion: 1, tool: found.qualifiedName, namespace: found.namespace, result };
  }
}
