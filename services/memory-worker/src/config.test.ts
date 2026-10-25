import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, readTrustedPublicationRepositories } from "./config";

const readConfigForTest = (environment: Record<string, string | undefined>, readCa?: (path: string) => string) =>
  readConfig(environment, readCa, () => ({ repository: "/checkout/repo" }));

const requiredEnvironment = {
  MEMORY_DATABASE_URL: "postgres://memory:test@localhost/memory",
  MEMORY_ISSUER: "https://auth.example.test",
  MEMORY_COMPANY_ROOT: "/config/company-repository",
  MEMORY_SESSION_TOKEN_PUBLIC_KEY_FILE: "/config/auth-public-key.pem",
  MEMORY_MODEL_CACHE_DIR: "/var/cache/wagglebot-memory",
  MEMORY_GITLEAKS_EXECUTABLE: "/usr/local/bin/gitleaks",
  MEMORY_GITLEAKS_SHA256: "a".repeat(64),
  MEMORY_ADMIN_BEARER_TOKEN: "test-admin-token",
  MEMORY_PUBLICATION_REPOSITORIES_FILE: "/config/publication-repositories.json",
};

test("requires MEMORY_DATABASE_URL and fixes the embedding profile", () => {
  expect(() => readConfigForTest({})).toThrow(/MEMORY_DATABASE_URL/);
  expect(readConfigForTest(requiredEnvironment)).toMatchObject({
    databaseUrl: "postgres://memory:test@localhost/memory",
    host: "0.0.0.0",
    port: 3000,
    issuer: "https://auth.example.test",
    companyRoot: "/config/company-repository",
    sessionTokenPublicKeyFile: "/config/auth-public-key.pem",
    modelCacheDir: "/var/cache/wagglebot-memory",
    gitleaksExecutable: "/usr/local/bin/gitleaks",
    gitleaksSha256: "a".repeat(64),
    adminBearerToken: "test-admin-token",
    publicationRepositoriesFile: "/config/publication-repositories.json",
    publicationRepositories: { repository: "/checkout/repo" },
    embeddingProfile: {
      provider: "xenova-transformers",
      model: "all-MiniLM-L6-v2",
      modelId: "Xenova/all-MiniLM-L6-v2",
      dimension: 384,
      distance: "cosine",
    },
  });
});

test("validates bind settings and requires verified TLS for remote databases", () => {
  expect(() =>
    readConfigForTest({ ...requiredEnvironment, MEMORY_DATABASE_URL: "postgres://worker:pass@db.example/memory" }),
  ).toThrow(/verify-full/);
  expect(() =>
    readConfigForTest(
      {
        ...requiredEnvironment,
        MEMORY_DATABASE_URL: "postgres://worker:pass@db.example/memory?sslmode=verify-full",
      },
      () => "ca cert",
    ),
  ).toThrow(/CA/);
  expect(
    readConfigForTest(
      {
        ...requiredEnvironment,
        MEMORY_DATABASE_URL: "postgres://worker:pass@db.example/memory?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.pem",
      },
      () => "test CA",
    ),
  ).toMatchObject({
    databaseUrl: "postgres://worker:pass@db.example/memory",
    ssl: { ca: "test CA", rejectUnauthorized: true },
  });
  expect(() => readConfigForTest({ ...requiredEnvironment, MEMORY_PORT: "70000" })).toThrow(/MEMORY_PORT/);
});

test("rejects connection-string options that can override the validated database target or session", () => {
  for (const option of [
    "host=attacker.example",
    "HOST=attacker.example",
    "port=5433",
    "options=-c%20timezone%3Dlocal",
    "ssl=0",
    "sslmode=verify-full&sslmode=disable",
  ]) {
    expect(() =>
      readConfigForTest(
        {
          ...requiredEnvironment,
          MEMORY_DATABASE_URL: `postgres://worker:pass@db.example/memory?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.pem&${option}`,
        },
        () => "test CA",
      ),
    ).toThrow(/connection string/i);
  }
});

test("allows bracketed IPv6 loopback without remote TLS settings", () => {
  const config = readConfigForTest({
    ...requiredEnvironment,
    MEMORY_DATABASE_URL: "postgres://memory:test@[::1]/memory",
  });
  expect(config.databaseUrl).toBe("postgres://memory:test@[::1]/memory");
  expect(config).not.toHaveProperty("ssl");
});

test("requires secure runtime files and an HTTPS issuer", () => {
  const invalidSettings = [
    ["MEMORY_ISSUER", "http://auth.example.test"],
    ["MEMORY_COMPANY_ROOT", "relative/company"],
    ["MEMORY_SESSION_TOKEN_PUBLIC_KEY_FILE", "relative/key.pem"],
    ["MEMORY_MODEL_CACHE_DIR", "relative/cache"],
    ["MEMORY_GITLEAKS_EXECUTABLE", "gitleaks"],
    ["MEMORY_GITLEAKS_SHA256", "abc"],
  ] as const;
  for (const [name, value] of invalidSettings) {
    expect(() => readConfigForTest({ ...requiredEnvironment, [name]: value })).toThrow(new RegExp(name));
  }
  expect(() => readConfigForTest({ ...requiredEnvironment, MEMORY_ADMIN_BEARER_TOKEN: "  " })).toThrow(
    /MEMORY_ADMIN_BEARER_TOKEN/,
  );
  expect(() =>
    readConfigForTest({ ...requiredEnvironment, MEMORY_PUBLICATION_REPOSITORIES_FILE: "relative.json" }),
  ).toThrow(/MEMORY_PUBLICATION_REPOSITORIES_FILE/);
});

test("trusted checkout file is a strict map of exact identities to existing absolute directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "wagglebot-checkouts-"));
  const file = join(directory, "repositories.json");
  try {
    writeFileSync(
      file,
      `{"__proto__":${JSON.stringify(process.cwd())},"constructor":${JSON.stringify(process.cwd())}}`,
    );
    const repositories = readTrustedPublicationRepositories(file);
    expect(Object.getPrototypeOf(repositories)).toBeNull();
    expect(Object.hasOwn(repositories, "__proto__")).toBe(true);
    expect(Object.hasOwn(repositories, "constructor")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(repositories, "__proto__")?.value).toBe(process.cwd());
    expect(Object.getOwnPropertyDescriptor(repositories, "constructor")?.value).toBe(process.cwd());

    writeFileSync(file, JSON.stringify({ repo: "relative/path" }));
    expect(() => readTrustedPublicationRepositories(file)).toThrow(/invalid checkout/);
    writeFileSync(file, "[]");
    expect(() => readTrustedPublicationRepositories(file)).toThrow(/repository map/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
