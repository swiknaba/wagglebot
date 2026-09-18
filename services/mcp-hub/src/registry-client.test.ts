import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProxyConfig } from "@wagglebot/contracts";
import { RegistryManager } from "./registry-client";

const snapshot = JSON.stringify({
  schemaVersion: 1,
  revision: `reg_${"a".repeat(64)}`,
  sourceRevision: "a".repeat(40),
  generatedAt: "2026-09-13T00:00:00.000Z",
  principal: { username: "alice" },
  proxies: [],
  toolCatalog: { version: 1, title: "T", platform_context: [], operating_principles: [], families: [] },
});
const config = (extra = {}) => ({
  host: "127.0.0.1",
  port: 9000,
  bearerToken: "x".repeat(32),
  configPath: "/tmp/registry.json",
  trustPath: "/tmp/trust",
  configRefreshSeconds: 0,
  startupStrict: false,
  listToolsCacheTtlSeconds: 30,
  codeModeEnabled: true,
  warmupToolsOnStartup: true,
  toolRefreshEnabled: true,
  toolRefreshIntervalSeconds: 300,
  toolRetrySeconds: 30,
  toolTimeoutSeconds: 5,
  toolMaxConcurrency: 4,
  ...extra,
});
const trust = { requireApproval: () => true } as never;

test("loads a mode-0600 local registry snapshot", async () => {
  const path = join(mkdtempSync(join("/tmp", "waggle-registry-")), "registry.json");
  writeFileSync(path, snapshot);
  chmodSync(path, 0o600);
  const manager = new RegistryManager({ config: config({ configPath: path }), trust });
  expect((await manager.refresh()).ok).toBe(true);
  expect(manager.current()?.revision).toMatch(/^reg_/);
});

test("sends authentication authorization only to the configured remote registry", async () => {
  const seen: RequestInit[] = [];
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry" }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async (_url, init) => {
      seen.push(init ?? {});
      return new Response(snapshot, { headers: { etag: `reg_${"a".repeat(64)}` } });
    },
  });
  expect((await manager.refresh()).ok).toBe(true);
  expect(new Headers(seen[0]?.headers).get("authorization")).toBe("Bearer d26");
});

test("keeps approved namespaces when another namespace requires approval", async () => {
  const registry = JSON.stringify({
    ...JSON.parse(snapshot),
    proxies: [
      { namespace: "approved", mode: "remote_http", endpoint: "https://approved.example/mcp" },
      { namespace: "unapproved", mode: "remote_http", endpoint: "https://unapproved.example/mcp" },
    ],
  });
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry" }),
    trust: { requireApproval: (proxy: ProxyConfig) => proxy.namespace === "approved" } as never,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async () => new Response(registry),
  });

  expect((await manager.refresh()).ok).toBe(true);
  expect(manager.current()?.proxies.map((proxy) => proxy.namespace)).toEqual(["approved"]);
});

test("retains the accepted snapshot after unchanged, oversized, and unauthorized remote responses", async () => {
  const responses = [
    new Response(snapshot, { headers: { etag: `reg_${"a".repeat(64)}` } }),
    new Response(null, { status: 304 }),
    new Response("x".repeat(262_145)),
    new Response(null, { status: 401 }),
  ];
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry" }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
  });

  const first = await manager.refresh();
  const accepted = manager.current();
  if (!accepted) throw new Error("expected an accepted registry snapshot");
  const unchanged = await manager.refresh();
  const oversized = await manager.refresh();
  const unauthorized = await manager.refresh();

  expect(first.ok).toBe(true);
  expect(unchanged).toEqual(first);
  expect(oversized.ok).toBe(false);
  expect(unauthorized.ok).toBe(false);
  expect(manager.current()).toBe(accepted);
});

test("rejects redirects without sending the registry token to another origin", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry" }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async (input, init) => {
      requests.push({ url: input.toString(), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(null, { status: 302, headers: { location: "https://other.example/registry" } });
    },
  });

  expect((await manager.refresh()).ok).toBe(false);
  expect(requests).toEqual([{ url: "https://registry.example/registry", authorization: "Bearer d26" }]);
});

test("coalesces concurrent refresh requests", async () => {
  let calls = 0;
  let release: ((response: Response) => void) | undefined;
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry" }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
  });

  const first = manager.refresh();
  const second = manager.refresh();
  await Promise.resolve();
  release?.(new Response(snapshot));

  expect(await first).toEqual(await second);
  expect(calls).toBe(1);
});
