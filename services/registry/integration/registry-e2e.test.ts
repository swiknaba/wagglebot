import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D26Audience } from "@wagglebot/contracts";
import { verifyD26SessionToken } from "@wagglebot/d26-auth";
import { generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/http";
import { RegistrySource } from "../src/source";

const directories: string[] = [];
const revision = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "waggle-registry-e2e-"));
  directories.push(root);
  await Promise.all([
    mkdir(join(root, "company"), { recursive: true }),
    mkdir(join(root, "teams", "alpha"), { recursive: true }),
    mkdir(join(root, "teams", "beta"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } })),
    writeFile(
      join(root, "company", "catalog.yaml"),
      `kind: Group
metadata: { name: alpha }
spec: { members: [alice] }
---
kind: Group
metadata: { name: beta }
spec: { members: [bob] }
---
kind: User
metadata: { name: alice }
spec: { memberOf: [alpha] }
---
kind: User
metadata: { name: bob }
spec: { memberOf: [beta] }
`,
    ),
    writeFile(
      join(root, "company", "registry.yaml"),
      `proxies:
  - namespace: shared
    mode: remote_http
    endpoint: https://company.example/mcp
  - namespace: company-only
    mode: remote_http
    endpoint: https://company.example/only
`,
    ),
    writeFile(
      join(root, "teams", "alpha", "registry.yaml"),
      `proxies:
  - namespace: shared
    mode: remote_http
    endpoint: https://alpha.example/mcp
  - namespace: alpha-only
    mode: remote_http
    endpoint: https://alpha.example/only
`,
    ),
    writeFile(
      join(root, "teams", "beta", "registry.yaml"),
      `proxies:
  - namespace: shared
    mode: remote_http
    endpoint: https://beta.example/mcp
  - namespace: beta-only
    mode: remote_http
    endpoint: https://beta.example/only
`,
    ),
    writeFile(join(root, "tool_catalog.yaml"), "version: 1\ntitle: Tools\nfamilies: []\n"),
  ]);
  const source = new RegistrySource({ companyRoot: root, sourceRevision: revision });
  await source.load();
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const issuer = "https://auth.example.test";
  const token = async (username: "alice" | "bob", audience: D26Audience = "wagglebot-registry") =>
    new SignJWT({ sub: username, aud: audience, jti: `jti_${"x".repeat(28)}` })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
  const app = createApp({
    source,
    verify: (value) => verifyD26SessionToken(value, { issuer, audience: "wagglebot-registry", publicKey }),
  });
  return { app, root, source, token };
}

const response = async (app: { fetch(request: Request): Promise<Response> }, token: string, query = "") =>
  app.fetch(
    new Request(`https://registry.example/registry${query}`, { headers: { authorization: `Bearer ${token}` } }),
  );

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("signed principals receive only their catalog-derived registry layers", async () => {
  const environment = await fixture();
  const alice = await response(environment.app, await environment.token("alice"), "?team=beta");
  const bob = await response(environment.app, await environment.token("bob"), "?team=alpha");
  const aliceSnapshot = await alice.json();
  const bobSnapshot = await bob.json();

  expect(alice.status).toBe(200);
  expect(bob.status).toBe(200);
  expect(aliceSnapshot).toMatchObject({ principal: { username: "alice" } });
  expect(bobSnapshot).toMatchObject({ principal: { username: "bob" } });
  expect((aliceSnapshot as { proxies: Array<{ namespace: string; mode: string; endpoint: string }> }).proxies).toEqual([
    { namespace: "alpha-only", mode: "remote_http", endpoint: "https://alpha.example/only" },
    { namespace: "company-only", mode: "remote_http", endpoint: "https://company.example/only" },
    { namespace: "shared", mode: "remote_http", endpoint: "https://alpha.example/mcp" },
  ]);
  expect(
    (bobSnapshot as { proxies: Array<{ namespace: string; mode: string; endpoint: string }> }).proxies.map(
      (item) => item.namespace,
    ),
  ).toEqual(["beta-only", "company-only", "shared"]);
  expect(alice.headers.get("etag")).not.toBe(bob.headers.get("etag"));
});

test("a registry keeps its accepted snapshot through an invalid refresh and rejects a wrong audience", async () => {
  const environment = await fixture();
  const token = await environment.token("alice");
  const before = await response(environment.app, token);
  const beforeBody = await before.text();

  await writeFile(join(environment.root, "company", "registry.yaml"), "proxies: not-a-list\n");
  expect((await environment.source.refresh()).ok).toBe(false);
  const after = await response(environment.app, token);

  expect(after.status).toBe(200);
  expect(await after.text()).toBe(beforeBody);
  expect((await response(environment.app, await environment.token("alice", "wagglebot-memory"))).status).toBe(401);
});

test("concurrent requests observe a complete registry revision", async () => {
  const environment = await fixture();
  const token = await environment.token("alice");
  const before = await response(environment.app, token).then((value) => value.text());
  await writeFile(
    join(environment.root, "company", "registry.yaml"),
    `proxies:
  - namespace: shared
    mode: remote_http
    endpoint: https://replacement.example/mcp
  - namespace: company-only
    mode: remote_http
    endpoint: https://company.example/only
`,
  );

  const requests = Array.from({ length: 20 }, () => response(environment.app, token).then((value) => value.text()));
  expect((await environment.source.refresh()).ok).toBe(true);
  const after = await response(environment.app, token).then((value) => value.text());
  const results = await Promise.all(requests);

  expect(after).not.toBe(before);
  expect(results.every((body) => body === before || body === after)).toBe(true);
});
