import { expect, test } from "bun:test";
import { createApp } from "./http";
import { RegistrySource } from "./source";

test("authenticates before serving registry and supports ETags", async () => {
  const source = new RegistrySource({ companyRoot: "/missing", sourceRevision: "a".repeat(40) });
  const app = createApp({
    source,
    verify: async (token) => {
      if (token !== "ok") throw new Error("bad");
      return { username: "alice" } as never;
    },
  });
  expect((await app.fetch(new Request("http://x/registry"))).status).toBe(401);
  expect((await app.fetch(new Request("http://x/registry", { headers: { authorization: "Bearer bad" } }))).status).toBe(
    401,
  );
  expect((await app.fetch(new Request("http://x/livez"))).status).toBe(200);
  expect((await app.fetch(new Request("http://x/readyz"))).status).toBe(503);
});

test("reports degraded readiness after a failed refresh", async () => {
  const source = new RegistrySource({ companyRoot: "/missing", sourceRevision: "a".repeat(40) });
  const app = createApp({ source, verify: async () => ({ username: "alice" }) as never });
  expect((await app.fetch(new Request("http://x/readyz"))).status).toBe(503);
});
