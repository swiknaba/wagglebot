import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ProxyConfig } from "@wagglebot/contracts";
import type { ResolvedCredential } from "../credentials";
import { createRemoteFetch, type RemoteFetchOptions } from "./remote-http";
import { McpUpstreamClient, type UpstreamClient } from "./types";

export function createRemoteSseClient(
  proxy: ProxyConfig,
  credential: ResolvedCredential | null,
  options: RemoteFetchOptions = {},
): UpstreamClient {
  if (proxy.endpoint === undefined) throw new Error("remote upstream requires an endpoint");
  const transport = new SSEClientTransport(new URL(proxy.endpoint), {
    fetch: createRemoteFetch(proxy, credential, options),
  });
  return new McpUpstreamClient(transport);
}
