import { readFile } from "node:fs/promises";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SessionTokenProvider } from "@wagglebot/auth-protocol";
import { AuthClient, SshAgentSigner } from "@wagglebot/auth-protocol";
import type { HubConfig, ProxyConfig } from "@wagglebot/contracts";
import { buildHubCatalog } from "./codemode/catalog";
import { CodeMode } from "./codemode/tools";
import { loadHubConfig } from "./config";
import { resolveCredential } from "./credentials";
import { DiscoveryCache } from "./discovery/cache";
import { DiscoveryScheduler } from "./discovery/refresh";
import { createIntrospection } from "./introspection";
import { createHubApp } from "./mcp/server";
import { RegistryManager } from "./registry-client";
import { TrustStore } from "./trust";
import { createRemoteHttpClient } from "./upstream/remote-http";
import { createRemoteSseClient } from "./upstream/remote-sse";
import { buildStdioOptions, createStdioClient } from "./upstream/stdio";
import { UpstreamManager } from "./upstream/types";

export { loadHubConfig } from "./config";
export { createHubApp } from "./mcp/server";
export { TrustStore } from "./trust";

type RegistryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HubRuntimeOptions = {
  env?: Record<string, string | undefined>;
  tokens?: SessionTokenProvider;
  fetch?: RegistryFetch;
  upstreamFetch?: FetchLike;
  trustStore?: TrustStore;
};

export type HubRuntime = {
  app: ReturnType<typeof createHubApp>;
  refreshRegistry(): ReturnType<RegistryManager["refresh"]>;
  close(): Promise<void>;
};

function authClientFromEnvironment(env: Record<string, string | undefined>): SessionTokenProvider {
  const baseUrl = env.MCP_HUB_AUTH_URL;
  const username = env.MCP_HUB_AUTH_USERNAME;
  const publicKeyPath = env.MCP_HUB_AUTH_PUBLIC_KEY_FILE;
  if (!baseUrl || !username || !publicKeyPath)
    throw new Error(
      "remote registry startup requires MCP_HUB_AUTH_URL, MCP_HUB_AUTH_USERNAME, and MCP_HUB_AUTH_PUBLIC_KEY_FILE",
    );
  try {
    return new AuthClient({ baseUrl, username, signer: new SshAgentSigner({ publicKeyPath }) });
  } catch {
    throw new Error("remote registry authentication configuration is invalid");
  }
}

async function credentialFor(proxy: ProxyConfig, config: HubConfig, env: Record<string, string | undefined>) {
  if (!proxy.auth) return null;
  try {
    return await resolveCredential(proxy.auth.source, {
      registryOrigin: config.configUrl ? "remote" : "local",
      env,
      readFile: async (path) => readFile(path, "utf8"),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isRemote(proxy: ProxyConfig): boolean {
  return proxy.mode === "remote_http" || proxy.mode === "remote_sse";
}

export async function createHubRuntime(config: HubConfig, options: HubRuntimeOptions = {}): Promise<HubRuntime> {
  const env = options.env ?? process.env;
  const trust = options.trustStore ?? new TrustStore(config.trustPath);
  await trust.load();
  const tokens = options.tokens ?? (config.configUrl ? authClientFromEnvironment(env) : undefined);
  const upstreams = new UpstreamManager({
    createRemoteClient: (proxy, credential) =>
      proxy.mode === "remote_sse"
        ? createRemoteSseClient(proxy, credential, options.upstreamFetch ? { fetch: options.upstreamFetch } : {})
        : createRemoteHttpClient(proxy, credential, options.upstreamFetch ? { fetch: options.upstreamFetch } : {}),
    createStdioClient: (proxy) => createStdioClient(proxy, env),
  });
  const cache = new DiscoveryCache({
    now: () => new Date(),
    retrySeconds: config.toolRetrySeconds,
    refreshSeconds: config.toolRefreshIntervalSeconds,
    ttlSeconds: config.listToolsCacheTtlSeconds,
  });
  let acceptingRegistryChanges = false;
  const proxies = () => registry.current()?.proxies ?? [];
  const getCredential = (proxy: ProxyConfig) => credentialFor(proxy, config, env);
  const scheduler = new DiscoveryScheduler({
    cache,
    proxies,
    upstreams,
    credentialFor: getCredential,
    maxConcurrency: config.toolMaxConcurrency,
    timeoutSeconds: config.toolTimeoutSeconds,
    refreshEnabled: config.toolRefreshEnabled,
    refreshIntervalSeconds: config.toolRefreshIntervalSeconds,
    warmupOnStart: false,
  });
  const registry = new RegistryManager({
    config,
    trust,
    ...(tokens ? { tokens } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onSnapshotChange: async (previous, next) => {
      for (const proxy of next.proxies) {
        if (proxy.mode !== "stdio_cmd" && proxy.mode !== "stdio_npx") continue;
        if (proxy.auth && (await getCredential(proxy)) === null) continue;
        buildStdioOptions(proxy, env);
      }
      const old = new Map((previous?.proxies ?? []).map((proxy) => [proxy.namespace, JSON.stringify(proxy)]));
      const nextIdentity = new Map(next.proxies.map((proxy) => [proxy.namespace, JSON.stringify(proxy)]));
      const changed = [...new Set([...old.keys(), ...nextIdentity.keys()])].filter(
        (namespace) => old.get(namespace) !== nextIdentity.get(namespace),
      );
      await scheduler.invalidate(changed);
    },
    onSnapshotChanged: async (_snapshot, signal) => {
      if (acceptingRegistryChanges) await scheduler.refreshAll(signal);
    },
  });
  let app: ReturnType<typeof createHubApp> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      acceptingRegistryChanges = false;
      await app?.close();
      await registry.stop();
      await scheduler.stop();
      await upstreams.close();
    })();
    return closing;
  };

  try {
    const registryResult = await registry.refresh();
    if (!registryResult.ok && registryResult.error.message === "stdio executable not found")
      throw new Error("stdio executable not found");
    if (!registryResult.ok && !config.configUrl) throw new Error("local registry could not be loaded");
    if (!registryResult.ok && config.startupStrict)
      throw new Error("remote registry unavailable during strict startup");

    const snapshot = registry.current();

    if (snapshot && (config.warmupToolsOnStartup || config.startupStrict)) await scheduler.refreshAll();
    if (config.startupStrict && snapshot) {
      const unreachable = (
        await Promise.all(
          snapshot.proxies.map(async (proxy) => {
            if (!isRemote(proxy) || (proxy.auth && (await getCredential(proxy)) === null)) return false;
            return cache.state(proxy.namespace).status === "error";
          }),
        )
      ).some(Boolean);
      if (unreachable) throw new Error("remote MCP namespace unavailable during strict startup");
    }

    const introspectionRuntime = await createIntrospection({ cache, registry: () => registry.current(), config });
    const codeMode = new CodeMode({
      catalog: () => buildHubCatalog(cache.states()),
      cache,
      proxies,
      upstreams,
      credentialFor: getCredential,
    });
    app = createHubApp({
      bearerToken: config.bearerToken,
      codeMode,
      introspection: introspectionRuntime.introspection,
      ready: () =>
        registry.current() !== undefined && [...cache.states().values()].every((state) => state.status !== "error"),
      codeModeEnabled: config.codeModeEnabled,
    });
    registry.start();
    scheduler.start();
    acceptingRegistryChanges = true;
    return { app, refreshRegistry: () => registry.refresh(), close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function startHub(config = loadHubConfig(), options: HubRuntimeOptions = {}) {
  const runtime = await createHubRuntime(config, options);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: (request) => runtime.app.fetch(request) });
  } catch {
    await runtime.close();
    throw new Error("MCP hub failed to bind its configured address");
  }
  let stopped: Promise<void> | undefined;
  return {
    port: server.port,
    async close(): Promise<void> {
      if (stopped) return stopped;
      stopped = (async () => {
        server.stop(true);
        await runtime.close();
      })();
      return stopped;
    },
  };
}

if (import.meta.main) {
  void startHub()
    .then((runtime) => {
      const shutdown = () => void runtime.close().finally(() => process.exit(0));
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      process.stderr.write("MCP hub: startup failed\n");
      process.exitCode = 1;
    });
}
