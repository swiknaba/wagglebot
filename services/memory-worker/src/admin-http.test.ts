import { expect, test } from "bun:test";
import { createAdminHttpApp } from "./admin-http";

function app(calls: string[] = []) {
  return createAdminHttpApp({
    adminBearerToken: "configured-secret",
    adminService: {
      rescan: async () => {
        calls.push("rescan");
        return { schemaVersion: 1, operationKey: "op", operationId: "id", scanned: 0, invalidated: 0, ruleIds: [] };
      },
      reindex: async () => ({ schemaVersion: 1, operationKey: "op", operationId: "id", queued: 0 }),
      runOnce: async () => ({
        schemaVersion: 1,
        operationKey: "op",
        operationId: "id",
        claimed: 0,
        completed: 0,
        failed: 0,
      }),
    },
    publicationService: {
      replaceSource: async () => ({
        schemaVersion: 1,
        operationKey: "op",
        sourceKey: "s",
        revision: "a".repeat(40),
        created: 0,
        updated: 0,
        invalidated: 0,
        unchanged: 0,
      }),
    },
  });
}

function request(authorization?: string, body = "{}") {
  return new Request("http://memory/v1/admin/rescan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": "admin-test",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body,
  });
}

test("admin routes distinguish missing and invalid configured bearer credentials", async () => {
  const calls: string[] = [];
  const handler = app(calls);
  const missing = await handler.fetch(request());
  if (!missing) throw new Error("admin route was not handled");
  expect(missing.status).toBe(401);
  expect((await missing.json()).error.code).toBe("admin_auth_required");

  const jwtLike = await handler.fetch(request("Bearer signed-session-jwt"));
  if (!jwtLike) throw new Error("admin route was not handled");
  expect(jwtLike.status).toBe(401);
  expect((await jwtLike.json()).error.code).toBe("admin_auth_invalid");
  expect(calls).toEqual([]);
});

test("admin routes accept only the configured bearer and enforce the streamed body cap", async () => {
  const calls: string[] = [];
  const handler = app(calls);
  const accepted = await handler.fetch(request("Bearer configured-secret"));
  expect(accepted?.status).toBe(200);
  expect(calls).toEqual(["rescan"]);

  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array([0]));
      controller.close();
    },
  });
  const response = await handler.fetch(
    new Request("http://memory/v1/admin/rescan", {
      method: "POST",
      headers: { authorization: "Bearer configured-secret", "content-type": "application/json" },
      body: oversized,
      duplex: "half",
    } as RequestInit),
  );
  if (!response) throw new Error("admin route was not handled");
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("request_too_large");
  expect(calls).toEqual(["rescan"]);
});

test("unrecognized failures return a content-free retryable envelope", async () => {
  const handler = createAdminHttpApp({
    adminBearerToken: "configured-secret",
    adminService: {
      rescan: async () => {
        throw new Error("private database detail");
      },
      reindex: async () => ({}),
      runOnce: async () => ({}),
    },
    publicationService: { replaceSource: async () => ({}) },
  });
  const response = await handler.fetch(request("Bearer configured-secret"));
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    schemaVersion: 1,
    error: { code: "memory_unavailable", message: "memory unavailable", correlationId: "admin-test", retryable: true },
  });
});
