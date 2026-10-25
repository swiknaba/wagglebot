import { expect, test } from "bun:test";
import { createSharedMemoryClient, isShareableQuery, SharedMemoryClientError } from "./client";

const tokens = {
  get: async () => ({ token: "session", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  invalidate: () => {},
};

test("query privacy rejects code, absolute paths, and credential-like content", () => {
  expect(isShareableQuery("how does token rotation work")).toBe(true);
  expect(isShareableQuery("inspect ```const password = 'x'``` please")).toBe(false);
  expect(isShareableQuery("why is /Users/alice/repo slow")).toBe(false);
  expect(isShareableQuery("my api_key=AKIA1234567890ABCDEF")).toBe(false);
});

test("shared client accepts HTTPS and explicit loopback only", () => {
  expect(() => createSharedMemoryClient({ baseUrl: "https://memory.example", tokens })).not.toThrow();
  expect(() => createSharedMemoryClient({ baseUrl: "http://127.0.0.1:9010", tokens })).not.toThrow();
  expect(() => createSharedMemoryClient({ baseUrl: "http://memory.example", tokens })).toThrow(SharedMemoryClientError);
  expect(() => createSharedMemoryClient({ baseUrl: "https://user:pass@memory.example", tokens })).toThrow();
});

test("shared query sends only the bounded worker request and refuses redirects", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createSharedMemoryClient({
    baseUrl: "https://memory.example",
    tokens,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ schemaVersion: 1, records: [] });
    },
  });
  await client.search(
    {
      schemaVersion: 1,
      purpose: "query",
      query: "rotation",
      cascade: { system: "payments", includeOrg: true },
      limit: 3,
    },
    new AbortController().signal,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://memory.example/v1/memory/search");
  expect(requests[0]?.init?.redirect).toBe("error");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    schemaVersion: 1,
    purpose: "query",
    query: "rotation",
    cascade: { system: "payments", includeOrg: true },
    limit: 3,
  });
});
