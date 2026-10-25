import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { readConfig, type WorkerConfig } from "../src/config";
import { startMemoryWorker } from "../src/index";
import { createMemoryRepository } from "../src/repository";

const productionSmoke = process.env.MEMORY_PRODUCTION_SMOKE === "1" ? test : test.skip;

function writeCompanyFixture(root: string): void {
  mkdirSync(join(root, "company"));
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  writeFileSync(
    join(root, "company", "catalog.yaml"),
    `apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: team-payments
spec:
  members: [alice]
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
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
spec:
  memberOf: [team-payments]
`,
  );
}

async function signedToken(privateKey: CryptoKey, issuer: string, audience = "wagglebot-memory"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("alice")
    .setJti(`jti_${randomUUID().replaceAll("-", "").slice(0, 28)}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(privateKey);
}

productionSmoke(
  "production composition serves real HTTP with the CPU model, PostgreSQL, catalog, and pinned scanner across restart",
  async () => {
    const requiredEnvironment = [
      "MEMORY_DATABASE_URL",
      "MEMORY_MODEL_CACHE_DIR",
      "MEMORY_GITLEAKS_EXECUTABLE",
      "MEMORY_GITLEAKS_SHA256",
      "MEMORY_ISSUER",
      "MEMORY_ADMIN_BEARER_TOKEN",
    ];
    if (requiredEnvironment.some((name) => !process.env[name]?.trim()))
      throw new Error(
        "production memory smoke test requires its database, model, scanner, issuer, and admin environment",
      );

    const root = mkdtempSync(join(tmpdir(), "wagglebot-memory-production-"));
    const configRoot = join(root, "company-fixture");
    const publicKeyPath = join(root, "auth-public-key.pem");
    const repositoriesPath = join(root, "publication-repositories.json");
    const operationKey = `production-smoke-${randomUUID()}`;
    const title = `Production smoke ${operationKey}`;
    let config: WorkerConfig | undefined;
    let repository: ReturnType<typeof createMemoryRepository> | undefined;
    let originalState: unknown;
    let worker: Awaited<ReturnType<typeof startMemoryWorker>> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;

    const start = async () => {
      if (!config) throw new Error("production memory smoke configuration is unavailable");
      worker = await startMemoryWorker({
        config,
        port: 0,
        serve: (options) => {
          server = Bun.serve({ ...options, port: 0 });
          return server;
        },
      });
      return `http://127.0.0.1:${server?.port}`;
    };

    try {
      mkdirSync(configRoot);
      execFileSync("git", ["init", "--quiet", configRoot]);
      writeCompanyFixture(configRoot);
      writeFileSync(repositoriesPath, JSON.stringify({ company: configRoot }));
      const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
      writeFileSync(publicKeyPath, await exportSPKI(publicKey));
      config = readConfig({
        ...process.env,
        MEMORY_HOST: "127.0.0.1",
        MEMORY_COMPANY_ROOT: configRoot,
        MEMORY_SESSION_TOKEN_PUBLIC_KEY_FILE: publicKeyPath,
        MEMORY_PUBLICATION_REPOSITORIES_FILE: repositoriesPath,
      });
      repository = createMemoryRepository(config);
      originalState = (await repository.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]
        ?.worker_state;
      await repository.assertReady();
      let baseUrl = await start();
      const token = await signedToken(privateKey, config.issuer);
      const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
      const authorizedJson = (path: string, body: unknown, bearer = token) =>
        request(path, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await request("/livez")).status).toBe(200);
      const readiness = await request("/readyz");
      expect(readiness.status).toBe(200);
      expect((await readiness.json()).status).toBe("ready");
      expect((await request("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
      expect(
        (
          await authorizedJson(
            "/v1/memories",
            {
              schemaVersion: 1,
              operationKey: `${operationKey}-wrong-audience`,
              scope: { kind: "domain", name: "payments" },
              kind: "fact",
              title: "Wrong audience is rejected",
              content: "This token is signed for the registry.",
              confidence: "high",
              provenance: [{ sourceType: "human", actor: "alice", capturedAt: new Date().toISOString() }],
            },
            await signedToken(privateKey, config.issuer, "wagglebot-registry"),
          )
        ).status,
      ).toBe(401);
      const sessionAdmin = await request("/v1/admin/rescan", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, operationKey: `${operationKey}-admin` }),
      });
      expect(sessionAdmin.status).toBe(401);

      const rememberBody = {
        schemaVersion: 1,
        operationKey: `${operationKey}-remember`,
        scope: { kind: "domain", name: "payments" },
        kind: "fact",
        title,
        content: "Checkout retries for five minutes before escalating.",
        confidence: "high",
        provenance: [{ sourceType: "human", actor: "alice", capturedAt: new Date().toISOString() }],
      };
      const rememberedResponse = await authorizedJson("/v1/memories", rememberBody);
      expect(rememberedResponse.status).toBe(200);
      const remembered = await rememberedResponse.json();
      const recordId = remembered.outcomes?.[0]?.recordId;
      if (typeof recordId !== "string") throw new Error("production smoke write returned no record ID");

      const fetched = await request(`/v1/memories/${recordId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(fetched.status).toBe(200);
      expect((await fetched.json()).record.id).toBe(recordId);

      const queried = await authorizedJson("/v1/memory/search", {
        schemaVersion: 1,
        purpose: "query",
        query: "checkout retries before escalating",
        cascade: { system: "checkout", domain: "payments", includeOrg: true },
      });
      expect(queried.status).toBe(200);
      expect(
        (await queried.json()).records.some((entry: { record: { id: string } }) => entry.record.id === recordId),
      ).toBe(true);

      await worker?.close();
      await worker?.close();
      worker = undefined;
      server = undefined;
      baseUrl = await start();
      const replay = await authorizedJson("/v1/memories", rememberBody);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(remembered);
      const rowCount = await repository.query(
        "SELECT count(*)::int AS count FROM wagglebot_memories WHERE title = $1",
        [title],
      );
      expect(Number(rowCount[0]?.count)).toBe(1);
    } finally {
      await worker?.close().catch(() => undefined);
      await repository?.query("DELETE FROM wagglebot_memories WHERE title = $1", [title]).catch(() => undefined);
      if (originalState !== undefined)
        await repository
          ?.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [
            JSON.stringify(originalState),
          ])
          .catch(() => undefined);
      await repository?.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
