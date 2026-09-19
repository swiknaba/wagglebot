import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProxyConfig } from "@wagglebot/contracts";
import type { ResolvedCredential } from "../credentials";
import { McpUpstreamClient, type UpstreamClient } from "./types";

export { HTTP_CONNECT_TIMEOUT_MS, HTTP_READ_TIMEOUT_MS } from "./types";

const MAX_REDIRECTS = 3;

export type RemoteFetchOptions = {
  fetch?: FetchLike;
  trustedOrigins?: readonly string[];
};

function endpointOf(proxy: ProxyConfig): URL {
  if (proxy.endpoint === undefined) throw new Error("remote upstream requires an endpoint");
  return new URL(proxy.endpoint);
}

function credentialHeaders(proxy: ProxyConfig, credential: ResolvedCredential | null): Headers {
  const headers = new Headers();
  if (credential === null || proxy.auth === undefined) return headers;
  const { scheme } = proxy.auth;
  if (scheme.kind === "bearer") headers.set("Authorization", `Bearer ${credential.value}`);
  if (scheme.kind === "basic") headers.set("Authorization", `Basic ${btoa(`${scheme.username}:${credential.value}`)}`);
  if (scheme.kind === "header") headers.set(scheme.name, `${scheme.prefix ?? ""}${credential.value}`);
  return headers;
}

function redirectLocation(response: Response, current: URL): URL | null {
  if (response.status < 300 || response.status > 399) return null;
  const location = response.headers.get("location");
  if (location === null) throw new Error("upstream redirect has no location");
  return new URL(location, current);
}

export function createRemoteFetch(
  proxy: ProxyConfig,
  credential: ResolvedCredential | null,
  options: RemoteFetchOptions = {},
): FetchLike {
  const endpoint = endpointOf(proxy);
  const trustedOrigins = new Set([endpoint.origin, ...(options.trustedOrigins ?? [])]);
  const fetchFn = options.fetch ?? globalThis.fetch;

  return async (url, init = {}) => {
    let target = new URL(url, endpoint);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (!trustedOrigins.has(target.origin)) throw new Error("untrusted redirect origin");
      const headers = new Headers(init.headers);
      headers.delete("Authorization");
      for (const [name, value] of credentialHeaders(proxy, credential)) headers.set(name, value);
      const response = await fetchFn(target, { ...init, headers, redirect: "manual" });
      const next = redirectLocation(response, target);
      if (next === null) return response;
      target = next;
    }
    throw new Error("upstream redirect limit exceeded");
  };
}

export function createRemoteHttpClient(
  proxy: ProxyConfig,
  credential: ResolvedCredential | null,
  options: RemoteFetchOptions = {},
): UpstreamClient {
  const transport = new StreamableHTTPClientTransport(endpointOf(proxy), {
    fetch: createRemoteFetch(proxy, credential, options),
  });
  return new McpUpstreamClient(transport);
}
