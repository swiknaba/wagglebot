import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./http";
import { RegistrySource } from "./source";

function validRoot() {
  const dir = mkdtempSync(join("/tmp", "waggle-http-"));
  writeFileSync(join(dir, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  mkdirSync(join(dir, "company"));
  writeFileSync(join(dir, "company", "catalog.yaml"), "kind: User\nmetadata: {name: alice}\n");
  writeFileSync(join(dir, "company", "registry.yaml"), "proxies: []\n");
  writeFileSync(join(dir, "tool_catalog.yaml"), "version: 1\ntitle: T\nfamilies: []\n");
  return dir;
}

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

test("authenticates ETags and ignores caller-selected identity fields", async () => {
  const source = new RegistrySource({ companyRoot: validRoot(), sourceRevision: "a".repeat(40) });
  await source.load();
  const app = createApp({
    source,
    verify: async (token) => {
      if (token !== "ok") throw new Error("bad");
      return { username: "alice" } as never;
    },
  });
  const first = await app.fetch(
    new Request("http://x/registry?team=other", { headers: { authorization: "Bearer ok", "x-wagglebot-user": "bob" } }),
  );
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag");
  expect(
    (
      await app.fetch(
        new Request("http://x/registry", { headers: { authorization: "Bearer ok", "if-none-match": etag ?? "" } }),
      )
    ).status,
  ).toBe(304);
  expect(
    (
      await app.fetch(
        new Request("http://x/registry", { headers: { authorization: "Bearer bad", "if-none-match": etag ?? "" } }),
      )
    ).status,
  ).toBe(401);
});

test("rejects a response over the configured limit", async () => {
  const source = new RegistrySource({ companyRoot: validRoot(), sourceRevision: "a".repeat(40) });
  await source.load();
  const app = createApp({ source, maxResponseBytes: 1, verify: async () => ({ username: "alice" }) as never });
  const response = await app.fetch(new Request("http://x/registry", { headers: { authorization: "Bearer ok" } }));
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("registry_response_too_large");
});
