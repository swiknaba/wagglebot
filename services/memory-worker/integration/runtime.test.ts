import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { EMBEDDING_PROFILE, type WorkerConfig } from "../src/config";
import { startMemoryWorker, type WorkerServerOptions } from "../src/index";

const directories: string[] = [];

function writeCatalog(root: string, groupMembers: string[], includeAlice = true) {
  const users = includeAlice
    ? "\n---\napiVersion: backstage.io/v1alpha1\nkind: User\nmetadata:\n  name: alice\nspec:\n  memberOf: []\n"
    : "";
  writeFileSync(
    join(root, "company", "catalog.yaml"),
    `apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: team-payments
spec:
  members: [${groupMembers.join(", ")}]
---
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: payments
spec:
  owner: team-payments
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: checkout
spec:
  owner: team-payments
  domain: payments
${users}`,
  );
}

async function signedToken(
  privateKey: CryptoKey,
  audience = "wagglebot-memory",
  expiresInSeconds = 600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("https://auth.example.test")
    .setAudience(audience)
    .setSubject("alice")
    .setJti(`jti_${"x".repeat(28)}`)
    .setIssuedAt(now - (expiresInSeconds < 0 ? 600 : 0))
    .setExpirationTime(now + expiresInSeconds)
    .sign(privateKey);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("production composition verifies signed tokens and reloads current company membership", async () => {
  const root = mkdtempSync(join(tmpdir(), "wagglebot-memory-runtime-"));
  directories.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, "company"));
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  writeCatalog(root, ["alice"]);

  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicKeyPath = join(root, "auth-public-key.pem");
  writeFileSync(publicKeyPath, await exportSPKI(publicKey));
  const config: WorkerConfig = {
    databaseUrl: "postgres://memory:test@localhost/memory",
    host: "127.0.0.1",
    port: 3000,
    issuer: "https://auth.example.test",
    companyRoot: root,
    sessionTokenPublicKeyFile: publicKeyPath,
    modelCacheDir: join(root, "model-cache"),
    gitleaksExecutable: "/gitleaks",
    gitleaksSha256: "a".repeat(64),
    adminBearerToken: "runtime-test-admin-token",
    publicationRepositoriesFile: join(root, "publication-repositories.json"),
    publicationRepositories: { company: root },
    embeddingProfile: EMBEDDING_PROFILE,
  };
  const repository = {
    assertReady: async () => undefined,
    query: async (sql: string) =>
      (sql.includes("SELECT worker_state")
        ? [{ worker_state: { operations: {}, sources: {}, reindex: { pending: [] } } }]
        : []) as never[],
    withTransaction: async <T>(callback: (tx: never) => Promise<T>) =>
      callback({
        query: async (sql: string) => {
          if (sql.includes("SELECT worker_state")) {
            return { rows: [{ worker_state: { operations: {}, sources: {}, reindex: { pending: [] } } }] };
          }
          return { rows: [] };
        },
      } as never),
    close: async () => undefined,
  };
  const scanner = {
    assertReady: async () => undefined,
    scanText: async () => ({ findings: [], count: 0 }),
    scanPersistedDTO: async () => ({ findings: [], count: 0 }),
  };
  let server: WorkerServerOptions | undefined;
  const worker = await startMemoryWorker({
    config,
    repository,
    scanner,
    embeddingProvider: { embed: async () => Array(384).fill(0) },
    serve: (options) => {
      server = options;
      return { stop: () => undefined };
    },
  });

  const runningServer = server;
  if (!runningServer) throw new Error("runtime server was not started");
  const request = (token: string, operationKey: string) =>
    runningServer.fetch(
      new Request("http://memory/v1/memories", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          operationKey,
          scope: { kind: "domain", name: "payments" },
          kind: "fact",
          title: "Retry window",
          content: "Retry for five minutes.",
          confidence: "high",
          provenance: [{ sourceType: "human", actor: "caller-forged", capturedAt: new Date().toISOString() }],
        }),
      }),
    );

  const valid = await signedToken(privateKey);
  expect((await request(valid, "runtime-write-1")).status).toBe(200);

  const adminAttempt = await runningServer.fetch(
    new Request("http://memory/v1/admin/rescan", {
      method: "POST",
      headers: { authorization: `Bearer ${valid}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operationKey: "jwt-admin-attempt" }),
    }),
  );
  expect(adminAttempt.status).toBe(401);
  expect((await adminAttempt.json()).error.code).toBe("admin_auth_invalid");

  const configuredAdmin = await runningServer.fetch(
    new Request("http://memory/v1/admin/rescan", {
      method: "POST",
      headers: { authorization: "Bearer runtime-test-admin-token", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operationKey: "configured-admin-attempt" }),
    }),
  );
  expect(configuredAdmin.status).toBe(200);

  writeCatalog(root, []);
  const membershipRemoved = await request(valid, "runtime-write-2");
  expect(membershipRemoved.status).toBe(403);
  expect((await membershipRemoved.json()).error.code).toBe("domain_owner_required");

  expect((await request(await signedToken(privateKey, "wagglebot-registry"), "runtime-write-3")).status).toBe(401);
  expect((await request(await signedToken(privateKey, "wagglebot-memory", -60), "runtime-write-4")).status).toBe(401);

  writeCatalog(root, [], false);
  const userRemoved = await request(valid, "runtime-write-5");
  expect(userRemoved.status).toBe(401);
  expect((await userRemoved.json()).error.code).toBe("auth_invalid");

  const mcpMissingToken = await runningServer.fetch(new Request("http://memory/mcp", { method: "POST", body: "{}" }));
  expect(mcpMissingToken.status).toBe(401);
  await worker.close();
});
