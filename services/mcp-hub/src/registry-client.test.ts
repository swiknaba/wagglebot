import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("sends D26 authorization only to the configured remote registry", async () => {
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
