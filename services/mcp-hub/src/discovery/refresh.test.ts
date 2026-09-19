import { expect, test } from "bun:test";
import { ProxyConfigSchema } from "@wagglebot/contracts";
import { type UpstreamClient, UpstreamManager } from "../upstream/types";
import { DiscoveryCache } from "./cache";
import { DiscoveryScheduler } from "./refresh";

const tool = { name: "list_issues", description: "Lists issues", inputSchema: { type: "object" as const } };

const proxy = (namespace: string) =>
  ProxyConfigSchema.parse({ namespace, mode: "remote_http", endpoint: `https://${namespace}.example/mcp` });

test("limits simultaneous discovery calls to the configured concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const client = (): UpstreamClient => ({
    async initialize() {},
    async listTools() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return [tool];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {},
  });
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  const scheduler = new DiscoveryScheduler({
    cache,
    proxies: () => [proxy("one"), proxy("two"), proxy("three")],
    upstreams: new UpstreamManager({ createRemoteClient: client, createStdioClient: client, removalGraceMs: 0 }),
    maxConcurrency: 2,
    timeoutSeconds: 5,
  });

  const refresh = scheduler.refreshAll();
  while (releases.length < 2) await Promise.resolve();
  expect(maximumActive).toBe(2);
  releases.splice(0).forEach((release) => {
    release();
  });
  while (releases.length < 1) await Promise.resolve();
  releases.splice(0).forEach((release) => {
    release();
  });
  await refresh;

  expect([...cache.states().values()].map((state) => state.status)).toEqual(["ready", "ready", "ready"]);
});

test("skips an authenticated namespace when its local credential is unavailable", async () => {
  let initialized = 0;
  const client = (): UpstreamClient => ({
    async initialize() {
      initialized += 1;
    },
    async listTools() {
      return [tool];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {},
  });
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  const scheduler = new DiscoveryScheduler({
    cache,
    proxies: () => [
      ProxyConfigSchema.parse({
        namespace: "private",
        mode: "remote_http",
        endpoint: "https://private.example/mcp",
        auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "PRIVATE_TOKEN" } },
      }),
    ],
    upstreams: new UpstreamManager({ createRemoteClient: client, createStdioClient: client, removalGraceMs: 0 }),
    maxConcurrency: 1,
    timeoutSeconds: 5,
  });

  await scheduler.refreshAll();

  expect(initialized).toBe(0);
  expect(cache.state("private").lastDiscoveryError).toBe("upstream credential unavailable");
});

test("bounds discovery even when an upstream ignores cancellation", async () => {
  const client = (): UpstreamClient => ({
    async initialize() {},
    async listTools() {
      return new Promise(() => undefined);
    },
    async callTool() {
      return { content: [] };
    },
    async close() {},
  });
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  const scheduler = new DiscoveryScheduler({
    cache,
    proxies: () => [proxy("stalled")],
    upstreams: new UpstreamManager({ createRemoteClient: client, createStdioClient: client, removalGraceMs: 0 }),
    maxConcurrency: 1,
    timeoutSeconds: 0,
  });

  const result = await Promise.race([
    scheduler.refreshAll().then(() => "completed"),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 50)),
  ]);

  expect(result).toBe("completed");
  expect(cache.state("stalled").lastDiscoveryError).toBe("upstream unavailable");
});
