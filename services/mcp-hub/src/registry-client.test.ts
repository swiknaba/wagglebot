import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProxyConfig } from "@wagglebot/contracts";
import { RegistryManager } from "./registry-client";
import { TrustStore } from "./trust";

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
const trust = { load: async () => undefined, requireApproval: () => true };

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
    trust: { load: async () => undefined, requireApproval: (proxy: ProxyConfig) => proxy.namespace === "approved" },
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
  while (!release) await Promise.resolve();
  release(new Response(snapshot));

  expect(await first).toEqual(await second);
  expect(calls).toBe(1);
});

test("starts an immediate remote refresh", async () => {
  let calls = 0;
  let fetchStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });

  const manager = new RegistryManager({
    config: config({
      configPath: undefined,
      configUrl: "https://registry.example/registry",
      configRefreshSeconds: 900,
    }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async () => {
      calls += 1;
      fetchStarted?.();
      return new Response(snapshot);
    },
  });

  try {
    manager.start();
    await started;
    expect(calls).toBe(1);
  } finally {
    await manager.stop();
  }
});

test("stop aborts an active refresh before it resolves", async () => {
  let aborted = false;
  let fetchStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const manager = new RegistryManager({
    config: config({
      configPath: undefined,
      configUrl: "https://registry.example/registry",
      configRefreshSeconds: 900,
    }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async (_input, init) => {
      fetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  });

  manager.start();
  await started;
  await manager.stop();

  expect(aborted).toBe(true);
});

test("stop detaches an abort-ignoring refresh before a later start", async () => {
  let calls = 0;
  let firstStarted: (() => void) | undefined;
  let releaseFirst: ((response: Response) => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const laterSnapshot = snapshot.replace(`reg_${"a".repeat(64)}`, `reg_${"b".repeat(64)}`);
  const manager = new RegistryManager({
    config: config({
      configPath: undefined,
      configUrl: "https://registry.example/registry",
      configRefreshSeconds: 900,
    }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted?.();
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return new Response(laterSnapshot);
    },
  });

  manager.start();
  await started;
  await manager.stop();

  manager.start();
  const second = manager.refresh();
  expect((await second).ok).toBe(true);
  expect(manager.current()?.revision).toBe(`reg_${"b".repeat(64)}`);

  releaseFirst?.(new Response(snapshot));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(manager.current()?.revision).toBe(`reg_${"b".repeat(64)}`);

  await manager.stop();
});

test("runs candidate invalidation before exposing a changed namespace snapshot", async () => {
  const path = join(mkdtempSync(join("/tmp", "waggle-registry-change-")), "registry.json");
  const proxy = (endpoint: string) => ({ namespace: "same", mode: "remote_http", endpoint });
  const body = (revision: string, endpoint: string) =>
    JSON.stringify({
      schemaVersion: 1,
      revision: `reg_${revision.repeat(64)}`,
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-09-13T00:00:00.000Z",
      principal: { username: "alice" },
      proxies: [proxy(endpoint)],
      toolCatalog: { version: 1, title: "T", platform_context: [], operating_principles: [], families: [] },
    });
  writeFileSync(path, body("a", "https://one.example/mcp"));
  chmodSync(path, 0o600);
  let manager: RegistryManager;
  const accepted: string[] = [];
  manager = new RegistryManager({
    config: config({ configPath: path }),
    trust,
    onSnapshotChange: async (previous, next) => {
      if (previous) expect(manager.current()?.revision).toBe(previous.revision);
      accepted.push(next.proxies[0]?.endpoint ?? "");
    },
  });
  await manager.refresh();
  writeFileSync(path, body("b", "https://two.example/mcp"));
  chmodSync(path, 0o600);
  await manager.refresh();
  expect(accepted).toEqual(["https://one.example/mcp", "https://two.example/mcp"]);
  expect(manager.current()?.proxies[0]?.endpoint).toBe("https://two.example/mcp");
});

test("does not advance the remote ETag when candidate invalidation rejects a snapshot", async () => {
  const initial = JSON.parse(snapshot) as Record<string, unknown>;
  let currentBody = snapshot;
  let currentEtag = "old-etag";
  const seenEtags: Array<string | null> = [];
  let rejectChanged = true;
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry" }),
    trust,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async (_input, init) => {
      const sentEtag = new Headers(init?.headers).get("if-none-match");
      seenEtags.push(sentEtag);
      if (sentEtag === currentEtag) return new Response(null, { status: 304 });
      return new Response(currentBody, { headers: { etag: currentEtag } });
    },
    onSnapshotChange: (_previous, next) => {
      if (next.revision !== initial.revision && rejectChanged) {
        rejectChanged = false;
        throw new Error("candidate rejected");
      }
    },
  });
  await manager.refresh();
  const changed = JSON.parse(snapshot.replace(`reg_${"a".repeat(64)}`, `reg_${"b".repeat(64)}`)) as Record<
    string,
    unknown
  >;
  currentBody = JSON.stringify(changed);
  currentEtag = "new-etag";
  expect((await manager.refresh()).ok).toBe(false);
  expect((await manager.refresh()).ok).toBe(true);
  expect(seenEtags).toEqual([null, "old-etag", "old-etag"]);
  expect(manager.current()?.revision).toBe(`reg_${"b".repeat(64)}`);
});

test("a namespace approved by another process activates from the next 304 refresh", async () => {
  const directory = mkdtempSync(join("/tmp", "waggle-registry-approval-"));
  const trustPath = join(directory, "trust.json");
  const proxy = {
    namespace: "approved-later",
    mode: "remote_http",
    endpoint: "https://approved-later.example/mcp",
  } as ProxyConfig;
  const raw = JSON.stringify({ ...JSON.parse(snapshot), proxies: [proxy] });
  const trustStore = new TrustStore(trustPath);
  let fetchCount = 0;
  const manager = new RegistryManager({
    config: config({ configPath: undefined, configUrl: "https://registry.example/registry", trustPath }),
    trust: trustStore,
    tokens: { get: async () => ({ token: "d26", expiresAt: "" }), invalidate: () => undefined },
    fetch: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? new Response(raw, { headers: { etag: "stable-etag" } })
        : new Response(null, { status: 304 });
    },
  });
  try {
    expect((await manager.refresh()).ok).toBe(true);
    expect(manager.current()?.proxies).toEqual([]);

    const separateApprover = new TrustStore(trustPath);
    await separateApprover.load();
    await separateApprover.approve(proxy, ["origin"]);

    expect((await manager.refresh()).ok).toBe(true);
    expect(manager.current()?.proxies.map(({ namespace }) => namespace)).toEqual(["approved-later"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
