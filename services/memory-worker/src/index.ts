import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { verifyAuthSessionToken } from "@wagglebot/auth-protocol";
import type { Catalog } from "@wagglebot/company-config";
import { loadCompanyRepo, loadCatalog as parseCatalog } from "@wagglebot/company-config";
import { importSPKI } from "jose";
import { createAdminService } from "./admin";
import { createAdminHttpApp } from "./admin-http";
import { readConfig, type WorkerConfig } from "./config";
import {
  configureEmbeddingCache,
  cpuEmbeddingProvider,
  type EmbeddingProvider,
  validateEmbeddingVector,
} from "./embeddings";
import { createMemoryHttpApp } from "./http";
import { createMemoryMcpApp } from "./mcp";
import { createMemoryPrincipalResolver } from "./principal";
import { createGitRevisionVerifier, createPublicationService } from "./publication";
import { createMemoryRepository, type MemoryRepository, type MemoryTransaction } from "./repository";
import { createSecretScanner } from "./scanner";
import { createSearchService } from "./search-service";
import { createWriteService } from "./write-service";

const GITLEAKS_VERSION = "8.30.1";

export type WorkerServerOptions = {
  port: number;
  hostname: string;
  fetch(request: Request): Response | Promise<Response>;
};

type MemoryScanner = Pick<ReturnType<typeof createSecretScanner>, "assertReady" | "scanText" | "scanPersistedDTO">;
type WorkerHealth = {
  status: "ready" | "degraded";
  dependencies: Record<string, string>;
};

export type MemoryWorkerDependencies = {
  repository?: MemoryRepository;
  embeddingProvider?: EmbeddingProvider;
  scanner?: MemoryScanner;
  verificationKey?: CryptoKey;
  loadCatalog?: () => Promise<Catalog>;
  config?: WorkerConfig;
  port?: number;
  serve?: (options: WorkerServerOptions) => { stop(closeActiveConnections?: boolean): void | Promise<void> };
};

async function prepareEmbeddingCache(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("invalid cache");
    await access(directory, fsConstants.R_OK | fsConstants.W_OK);
    configureEmbeddingCache(directory);
  } catch {
    throw new Error("memory model cache unavailable");
  }
}

function assertPublicationCheckouts(checkouts: Readonly<Record<string, string>>): void {
  for (const checkout of Object.values(checkouts)) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
    try {
      const result = execFileSync(
        "git",
        ["--no-optional-locks", "--no-replace-objects", "-C", checkout, "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 },
      );
      if (result.trim() !== "true") throw new Error("invalid checkout");
    } catch {
      throw new Error("memory publication checkout unavailable");
    }
  }
}

async function importVerificationKey(path: string): Promise<CryptoKey> {
  try {
    return await importSPKI(await readFile(path, "utf8"), "EdDSA");
  } catch {
    throw new Error("memory verification key unavailable");
  }
}

function companyCatalogLoader(companyRoot: string): () => Promise<Catalog> {
  return async () => {
    const company = loadCompanyRepo(companyRoot);
    if (!company.catalog) throw new Error("company catalog is missing");
    return parseCatalog(company.catalog.text, company.catalog.path);
  };
}

async function shutdownAll(
  server: { stop(closeActiveConnections?: boolean): void | Promise<void> } | undefined,
  mcp: { close(): Promise<void> } | undefined,
  repository: MemoryRepository,
): Promise<void> {
  let failed = false;
  for (const close of [async () => server?.stop(true), async () => mcp?.close(), async () => repository.close()]) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("memory worker shutdown failed");
}

export async function startMemoryWorker(
  dependencies: MemoryWorkerDependencies = {},
): Promise<{ close(): Promise<void> }> {
  const config = dependencies.config ?? readConfig();
  const repository = dependencies.repository ?? createMemoryRepository(config);
  const embeddingProvider = dependencies.embeddingProvider ?? cpuEmbeddingProvider;
  const scanner =
    dependencies.scanner ??
    createSecretScanner({
      gitleaks: {
        executable: config.gitleaksExecutable,
        version: GITLEAKS_VERSION,
        sha256: config.gitleaksSha256,
      },
    });
  const loadCatalog = dependencies.loadCatalog ?? companyCatalogLoader(config.companyRoot);
  let server: ReturnType<NonNullable<MemoryWorkerDependencies["serve"]>> | undefined;
  let mcp: ReturnType<typeof createMemoryMcpApp> | undefined;

  try {
    await prepareEmbeddingCache(config.modelCacheDir);
    const verificationKey =
      dependencies.verificationKey ?? (await importVerificationKey(config.sessionTokenPublicKeyFile));
    await loadCatalog();
    assertPublicationCheckouts(config.publicationRepositories);
    await repository.assertReady();
    const scanSmoke = await scanner.scanText("");
    if (scanSmoke.count !== 0) throw new Error("scanner smoke failed");
    validateEmbeddingVector(await embeddingProvider.embed("Wagglebot memory worker readiness check"));

    const resolvePrincipal = createMemoryPrincipalResolver({
      verifyToken: (token, audience) =>
        verifyAuthSessionToken(token, { issuer: config.issuer, audience, publicKey: verificationKey }),
      loadCatalog,
    });
    const writeService = createWriteService({ repository, loadCatalog, scanner, embeddingProvider });
    const searchService = createSearchService({ repository, loadCatalog, embeddingProvider });
    const adminService = createAdminService({ repository, scanner, embeddingProvider });
    const publicationService = createPublicationService({
      repository,
      git: createGitRevisionVerifier(config.publicationRepositories),
      loadCatalog,
      scanner,
      embeddingProvider,
    });
    const adminHttpApp = createAdminHttpApp({
      adminBearerToken: config.adminBearerToken,
      adminService,
      publicationService,
    });
    const httpApp = createMemoryHttpApp({
      resolvePrincipal,
      writeService,
      searchService,
      health: async (): Promise<WorkerHealth> => {
        const dependencies: Record<string, string> = {
          database: "ready",
          catalog: "ready",
          scanner: "ready",
          embedding: "ready",
          verificationKey: "ready",
          publicationRepositories: "ready",
        };
        try {
          await repository.assertReady();
        } catch {
          dependencies.database = "unavailable";
        }
        try {
          await loadCatalog();
        } catch {
          dependencies.catalog = "unavailable";
        }
        try {
          await scanner.assertReady();
        } catch {
          dependencies.scanner = "unavailable";
        }
        const status = Object.values(dependencies).every((value) => value === "ready") ? "ready" : "degraded";
        return { status, dependencies };
      },
    });
    mcp = createMemoryMcpApp({ resolvePrincipal, writeService, searchService });
    const mcpApp = mcp;
    const serve = dependencies.serve ?? ((options) => Bun.serve(options));
    server = serve({
      port: dependencies.port ?? config.port,
      hostname: config.host,
      fetch(request) {
        if (new URL(request.url).pathname === "/mcp") return mcpApp.fetch(request);
        return adminHttpApp.fetch(request).then((response) => response ?? httpApp.fetch(request));
      },
    });
  } catch {
    await shutdownAll(server, mcp, repository).catch(() => undefined);
    throw new Error("memory worker startup dependency check failed");
  }

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= shutdownAll(server, mcp, repository);
      return closePromise;
    },
  };
}

export type { MemoryRepository, MemoryTransaction };

async function runMemoryWorker(): Promise<void> {
  let worker: Awaited<ReturnType<typeof startMemoryWorker>>;
  try {
    worker = await startMemoryWorker();
  } catch {
    console.error("memory worker startup failed");
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    const timeout = setTimeout(() => process.exit(1), 10_000);
    void worker.close().then(
      () => {
        clearTimeout(timeout);
        process.exitCode = 0;
      },
      () => {
        clearTimeout(timeout);
        console.error("memory worker shutdown failed");
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) await runMemoryWorker();
