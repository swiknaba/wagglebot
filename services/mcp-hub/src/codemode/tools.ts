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

export class CodeMode {
  public constructor(private readonly options: CodeModeOptions) {}

  public search(query: string): Array<{ tool: string; namespace: string; description: string }> {
    if ([...query].length > 500) throw new Error("hub_invalid_request");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.options
      .catalog()
      .filter((tool) => terms.every((term) => `${tool.qualifiedName} ${tool.description}`.toLowerCase().includes(term)))
      .slice(0, 20)
      .map((tool) => ({ tool: tool.qualifiedName, namespace: tool.namespace, description: tool.description }));
  }

  public getSchema(tool: string): { tool: string; inputSchema: Record<string, unknown> } {
    const found = this.options.catalog().find((candidate) => candidate.qualifiedName === tool);
    if (!found) throw new Error("hub_tool_unavailable");
    return { tool: found.qualifiedName, inputSchema: structuredClone(found.inputSchema) };
  }

  public async execute(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
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
    return result;
  }
}
