import { expect, test } from "bun:test";
import { createMemoryHttpApp } from "./http";

const principal = {
  username: "alice",
  issuedAt: new Date("2026-10-18T10:00:00.000Z"),
  expiresAt: new Date("2026-10-18T11:00:00.000Z"),
  tokenId: "token-1",
  groups: [],
  orgOwner: false,
};

function makeApp() {
  const calls: string[] = [];
  const app = createMemoryHttpApp({
    resolvePrincipal: async (token) => {
      if (token !== "valid") throw Object.assign(new Error("invalid"), { code: "auth_invalid" });
      return principal;
    },
    writeService: {
      remember: async () => {
        calls.push("remember");
        return { schemaVersion: 1, operationKey: "x", outcomes: [] };
      },
      propose: async () => {
        calls.push("propose");
        return {};
      },
      invalidate: async () => {
        calls.push("invalidate");
        return {};
      },
    } as never,
    searchService: { search: async () => ({}), get: async () => ({}) } as never,
  });
  return { app, calls };
}

test("memory HTTP returns a bounded safe error envelope for a missing bearer token", async () => {
  const { app } = makeApp();
  const response = await app.fetch(
    new Request("http://memory/v1/memory/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-correlation-id": "corr-test" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "auth_required", message: "auth required", correlationId: "corr-test", retryable: false },
  });
});

test("memory HTTP enforces the actual streamed body cap and does not call a mutation service", async () => {
  const { app, calls } = makeApp();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const response = await app.fetch(
    new Request("http://memory/v1/memories", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body,
      // A stream avoids a content-length shortcut and exercises the actual byte counter.
      duplex: "half",
    } as RequestInit),
  );
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("request_too_large");
  expect(calls).toEqual([]);
});

test("readiness returns injected dependency states and degrades safely", async () => {
  const readyResponse = await createMemoryHttpApp({
    resolvePrincipal: async () => principal,
    writeService: {} as never,
    searchService: {} as never,
    health: async () => ({ status: "ready", dependencies: { database: "ready", scanner: "ready" } }),
  }).fetch(new Request("http://memory/readyz"));
  expect(readyResponse.status).toBe(200);
  expect(await readyResponse.json()).toMatchObject({
    status: "ready",
    dependencies: { database: "ready", scanner: "ready" },
  });

  const degradedApp = createMemoryHttpApp({
    resolvePrincipal: async () => principal,
    writeService: {} as never,
    searchService: {} as never,
    health: async () => ({ status: "degraded", dependencies: { database: "unavailable", scanner: "ready" } }),
  });
  const degraded = await degradedApp.fetch(new Request("http://memory/readyz"));
  expect(degraded.status).toBe(503);
  expect(await degraded.json()).toMatchObject({ status: "degraded", dependencies: { database: "unavailable" } });
});
