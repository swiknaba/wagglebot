import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_PROFILE, type WorkerConfig } from "./config";
import { type MemoryWorkerDependencies, startMemoryWorker, type WorkerServerOptions } from "./index";

const checkout = mkdtempSync(join(tmpdir(), "wagglebot-memory-startup-"));
execFileSync("git", ["init", "--quiet", checkout]);
afterAll(() => rmSync(checkout, { recursive: true, force: true }));

const config: WorkerConfig = {
  databaseUrl: "postgres://memory:test@localhost/memory",
  host: "127.0.0.1",
  port: 3000,
  issuer: "https://auth.example.test",
  companyRoot: "/company",
  sessionTokenPublicKeyFile: "/key.pem",
  modelCacheDir: join(checkout, "model-cache"),
  gitleaksExecutable: "/gitleaks",
  gitleaksSha256: "a".repeat(64),
  adminBearerToken: "test-admin-token",
  publicationRepositoriesFile: "/config/publication-repositories.json",
  publicationRepositories: { company: checkout },
  embeddingProfile: EMBEDDING_PROFILE,
};

function dependencies(
  events: string[],
  options: {
    assertReady?: () => Promise<void>;
    assertScannerReady?: () => Promise<void>;
    scanText?: () => Promise<{ findings: []; count: number }>;
  } = {},
): MemoryWorkerDependencies {
  return {
    config,
    verificationKey: {} as CryptoKey,
    loadCatalog: async () => {
      events.push("catalog");
      return { domains: [], systems: [], groups: [], users: [] };
    },
    repository: {
      assertReady:
        options.assertReady ??
        (async () => {
          events.push("ready");
        }),
      query: async () => [] as never[],
      withTransaction: async <T>() => undefined as T,
      close: async () => {
        events.push("close");
      },
    },
    scanner: {
      assertReady: async () => {
        events.push("scanner-ready");
        await options.assertScannerReady?.();
      },
      scanText: async () => {
        events.push("scan");
        await options.assertScannerReady?.();
        return options.scanText ? options.scanText() : { findings: [], count: 0 };
      },
      scanPersistedDTO: async () => ({ findings: [], count: 0 }),
    },
    embeddingProvider: {
      embed: async () => {
        events.push("warm");
        return Array(384).fill(0);
      },
    },
    serve: (options) => {
      events.push("listen");
      serverOptions = options;
      return {
        stop: () => {
          events.push("stop");
        },
      };
    },
  };
}

let serverOptions: WorkerServerOptions | undefined;

test("validates dependencies before listening and serves shared JSON health routes", async () => {
  const events: string[] = [];
  const handle = await startMemoryWorker(dependencies(events));
  expect(events).toEqual(["catalog", "ready", "scan", "warm", "listen"]);

  const live = await serverOptions?.fetch(new Request("http://localhost/livez"));
  expect(live?.status).toBe(200);
  expect(await live?.json()).toEqual({ schemaVersion: 1, status: "live" });
  const ready = await serverOptions?.fetch(new Request("http://localhost/readyz"));
  expect(ready?.status).toBe(200);
  expect(await ready?.json()).toEqual({
    schemaVersion: 1,
    status: "ready",
    dependencies: {
      database: "ready",
      catalog: "ready",
      scanner: "ready",
      embedding: "ready",
      verificationKey: "ready",
      publicationRepositories: "ready",
    },
  });
  await handle.close();
  await handle.close();
  expect(events).toEqual([
    "catalog",
    "ready",
    "scan",
    "warm",
    "listen",
    "ready",
    "catalog",
    "scanner-ready",
    "stop",
    "close",
  ]);
});

test("reports stable degraded readiness when the database is unavailable", async () => {
  const events: string[] = [];
  let readinessChecks = 0;
  const handle = await startMemoryWorker(
    dependencies(events, {
      assertReady: async () => {
        readinessChecks += 1;
        if (readinessChecks === 1) return;
        throw new Error("secret database detail");
      },
    }),
  );

  const response = await serverOptions?.fetch(new Request("http://localhost/readyz"));
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    schemaVersion: 1,
    status: "degraded",
    dependencies: {
      database: "unavailable",
      catalog: "ready",
      publicationRepositories: "ready",
      scanner: "ready",
      embedding: "ready",
      verificationKey: "ready",
    },
  });
  await handle.close();
});

test("reports scanner unavailable when its pin check fails after startup", async () => {
  const events: string[] = [];
  let checks = 0;
  const handle = await startMemoryWorker(
    dependencies(events, {
      assertScannerReady: async () => {
        checks += 1;
        if (checks > 1) throw new Error("secret scanner detail");
      },
    }),
  );

  const response = await serverOptions?.fetch(new Request("http://localhost/readyz"));
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    schemaVersion: 1,
    status: "degraded",
    dependencies: {
      database: "ready",
      catalog: "ready",
      publicationRepositories: "ready",
      scanner: "unavailable",
      embedding: "ready",
      verificationKey: "ready",
    },
  });
  expect(events).toContain("scanner-ready");
  await handle.close();
});

test("shutdown attempts every cleanup once even when server stop fails", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.serve = (options) => {
    serverOptions = options;
    return {
      stop: () => {
        throw new Error("raw stop detail");
      },
    };
  };
  const handle = await startMemoryWorker(deps);
  await expect(handle.close()).rejects.toThrow("memory worker shutdown failed");
  await expect(handle.close()).rejects.toThrow("memory worker shutdown failed");
  expect(events.filter((event) => event === "close")).toHaveLength(1);
});

test("refuses to listen and closes the repository when database readiness fails", async () => {
  const events: string[] = [];
  await expect(
    startMemoryWorker(
      dependencies(events, {
        assertReady: async () => {
          events.push("ready");
          throw new Error("migration mismatch");
        },
      }),
    ),
  ).rejects.toThrow("memory worker startup dependency check failed");
  expect(events).toEqual(["catalog", "ready", "close"]);
});

test("refuses to listen when the scanner smoke reports a finding", async () => {
  const events: string[] = [];
  await expect(
    startMemoryWorker(dependencies(events, { scanText: async () => ({ findings: [], count: 1 }) })),
  ).rejects.toThrow("memory worker startup dependency check failed");
  expect(events).toEqual(["catalog", "ready", "scan", "close"]);
});
