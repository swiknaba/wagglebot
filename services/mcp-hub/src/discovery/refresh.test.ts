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

test("keeps the four-call limit across overlapping discovery batches", async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  const scheduler = new DiscoveryScheduler({
    cache,
    proxies: () => ["one", "two", "three", "four", "five"].map(proxy),
    upstreams: new UpstreamManager({
      createRemoteClient: () => ({
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
      }),
      createStdioClient: () => {
        throw new Error("unexpected stdio client");
      },
      removalGraceMs: 0,
    }),
    maxConcurrency: 4,
    timeoutSeconds: 5,
  });

  const first = scheduler.refreshAll();
  while (releases.length < 4) await Promise.resolve();
  const second = scheduler.refreshDue();
  let completed = 0;
  while (completed < 5) {
    while (releases.length === 0) await Promise.resolve();
    const batch = releases.splice(0);
    completed += batch.length;
    batch.forEach((release) => {
      release();
    });
  }
  await Promise.all([first, second]);

  expect(maximumActive).toBe(4);
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

test("invalidates cached tools and stdio clients when a namespace identity changes", async () => {
  const events: string[] = [];
  let current = ProxyConfigSchema.parse({ namespace: "same", mode: "stdio_cmd", command: "/tmp/old" });
  let fail = false;
  const client = (): UpstreamClient => ({
    async initialize() {},
    async listTools() {
      if (fail) throw new Error("offline");
      return [tool];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {
      events.push("closed");
    },
  });
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  const scheduler = new DiscoveryScheduler({
    cache,
    proxies: () => [current],
    upstreams: new UpstreamManager({ createRemoteClient: client, createStdioClient: client, removalGraceMs: 0 }),
    maxConcurrency: 1,
    timeoutSeconds: 5,
  });
  await scheduler.refreshAll();
  expect(cache.state("same").status).toBe("ready");
  current = ProxyConfigSchema.parse({ namespace: "same", mode: "stdio_cmd", command: "/tmp/changed" });
  fail = true;
  await scheduler.refreshAll();
  expect(cache.state("same").status).toBe("error");
  expect(cache.state("same").tools).toEqual([]);
  expect(events).toEqual(["closed"]);
});
