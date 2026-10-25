import { expect, test } from "bun:test";
import { runMemoryAdmin } from "./memory-admin";

const env = { MEMORY_WORKER_URL: "https://memory.example.test", MEMORY_ADMIN_BEARER_TOKEN: "private-admin-token" };

test("admin CLI sends strict public requests and prints only the validated operation result", async () => {
  const lines: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const code = await runMemoryAdmin({
    args: ["admin", "run-once", "--operation-key", "drain-1", "--limit", "2"],
    env,
    write: (line) => lines.push(line),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({
        schemaVersion: 1,
        operationKey: "drain-1",
        operationId: "run-1",
        claimed: 2,
        completed: 1,
        failed: 1,
      });
    },
  });
  expect(code).toBe(0);
  expect(requests[0]?.url).toBe("https://memory.example.test/v1/admin/run-once");
  expect(requests[0]?.init).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { authorization: "Bearer private-admin-token" },
  });
  expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ schemaVersion: 1, operationKey: "drain-1", limit: 2 });
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ operationKey: "drain-1", completed: 1 });
  expect(lines.join("\n")).not.toContain("private-admin-token");
});

test("admin CLI rejects invalid commands and options before any network call", async () => {
  for (const args of [
    [],
    ["rescan"],
    ["admin", "unknown"],
    ["admin", "rescan"],
    ["admin", "rescan", "--operation-key", "op", "--limit", "2"],
    ["admin", "run-once", "--operation-key", "op", "--limit", "1e2"],
    ["admin", "reindex", "--operation-key", "op", "--extra"],
  ]) {
    let calls = 0;
    const code = await runMemoryAdmin({
      args,
      env,
      write: () => {},
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    expect(code).toBe(2);
    expect(calls).toBe(0);
  }
});

test("admin CLI rejects unsafe endpoints without printing URLs, credentials or raw errors", async () => {
  for (const endpoint of [
    "http://memory.example.test",
    "https://user:password@memory.example.test",
    "https://memory.example.test?token=private",
    "file:///private/memory",
    "https://memory.example.test/path",
    "http://127.0.0.1.evil.test",
  ]) {
    const lines: string[] = [];
    let calls = 0;
    expect(
      await runMemoryAdmin({
        args: ["admin", "rescan", "--operation-key", "scan"],
        env: { ...env, MEMORY_WORKER_URL: endpoint },
        write: (line) => lines.push(line),
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      }),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(lines.join("\n")).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain("private-admin-token");
  }
});

test("admin CLI permits explicitly configured loopback HTTP and uses rescan/reindex contracts", async () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    for (const action of ["rescan", "reindex"]) {
      expect(
        await runMemoryAdmin({
          args: ["admin", action, "--operation-key", "op"],
          env: { ...env, MEMORY_WORKER_URL: `http://${host}:3011` },
          write: () => {},
          fetch: async () =>
            Response.json({
              schemaVersion: 1,
              operationKey: "op",
              operationId: "id",
              ...(action === "rescan" ? { scanned: 1, invalidated: 0, ruleIds: [] } : { queued: 1 }),
            }),
        }),
      ).toBe(0);
    }
  }
});

test("admin CLI reports safe typed failures and rejects malformed or oversized success bodies", async () => {
  for (const response of [
    () =>
      Response.json(
        {
          schemaVersion: 1,
          error: { code: "admin_auth_invalid", message: "private detail", correlationId: "c", retryable: false },
        },
        { status: 401 },
      ),
    () =>
      Response.json({ schemaVersion: 1, operationKey: "op", operationId: "id", queued: 1, source: "private detail" }),
    () => new Response("private detail".repeat(100_000)),
    () => new Response(new Uint8Array([0xff, 0xfe])),
    () => {
      throw new Error("private detail");
    },
  ]) {
    const lines: string[] = [];
    expect(
      await runMemoryAdmin({
        args: ["admin", "reindex", "--operation-key", "op"],
        env,
        write: (line) => lines.push(line),
        fetch: async () => response(),
      }),
    ).toBe(1);
    expect(lines.join("\n")).not.toContain("private detail");
    expect(lines.join("\n")).not.toContain("private-admin-token");
  }
});
