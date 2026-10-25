import { expect, test } from "bun:test";
import { readConfig } from "./config";
import { assertReady, poolOptions } from "./repository";

const workerEnvironment = {
  MEMORY_ISSUER: "https://auth.example.test",
  MEMORY_COMPANY_ROOT: "/company",
  MEMORY_SESSION_TOKEN_PUBLIC_KEY_FILE: "/key.pem",
  MEMORY_MODEL_CACHE_DIR: "/cache",
  MEMORY_GITLEAKS_EXECUTABLE: "/gitleaks",
  MEMORY_GITLEAKS_SHA256: "a".repeat(64),
  MEMORY_ADMIN_BEARER_TOKEN: "test-admin",
  MEMORY_PUBLICATION_REPOSITORIES_FILE: "/repositories.json",
};

const metadata = {
  provider: "xenova-transformers",
  model: "all-MiniLM-L6-v2",
  dimension: 384,
  distance: "cosine",
  schema_version: 1,
};

function fakePool(options: { filenames?: string[]; profile?: typeof metadata } = {}) {
  return {
    async query(sql: string) {
      if (sql.includes("wagglebot_schema_migrations")) {
        return {
          rows: (
            options.filenames ?? [
              "20260916130000_create_memory_schema.rb",
              "20261006120000_complete_memory_wire_mapping.rb",
            ]
          ).map((filename) => ({ filename })),
        };
      }
      if (sql.includes("wagglebot_memory_schema_metadata")) return { rows: [options.profile ?? metadata] };
      if (sql.includes("wagglebot_memories")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("readiness rejects migration history and embedding profile mismatches", async () => {
  await expect(assertReady(fakePool({ filenames: [] }) as never)).rejects.toThrow(/migration/i);
  await expect(assertReady(fakePool({ profile: { ...metadata, dimension: 768 } }) as never)).rejects.toThrow(
    /embedding profile/i,
  );
});

test("readiness validates manifests safely and never reflects driver errors", async () => {
  await expect(
    assertReady(fakePool() as never, { latest: "20260916130000", migrations: null } as never),
  ).rejects.toThrow(/manifest is invalid/i);
  const unsafePool = {
    async query() {
      throw new Error("database secret: embedding profile mismatch at db.internal");
    },
  };
  await expect(assertReady(unsafePool as never)).rejects.toThrow(
    "memory database readiness check failed; verify migrations, memory metadata, and database availability",
  );
});

test("builds explicit PostgreSQL pool settings with controlled TLS and UTC options", () => {
  const local = poolOptions(
    readConfig(
      { ...workerEnvironment, MEMORY_DATABASE_URL: "postgres://worker:p%40ss@[::1]:5544/memory%20db" },
      undefined,
      () => ({ "test-repository": "/checkout" }),
    ),
  );
  expect(local).toMatchObject({
    host: "::1",
    port: 5544,
    user: "worker",
    password: "p@ss",
    database: "memory db",
    options: "-c timezone=UTC",
  });
  expect(local).not.toHaveProperty("connectionString");
  expect(local).not.toHaveProperty("ssl");

  const remote = poolOptions(
    readConfig(
      {
        ...workerEnvironment,
        MEMORY_DATABASE_URL: "postgres://worker:pass@db.example:5434/memory?sslmode=verify-full&sslrootcert=%2Fca.pem",
      },
      () => "test CA",
      () => ({ "test-repository": "/checkout" }),
    ),
  );
  expect(remote).toMatchObject({
    host: "db.example",
    port: 5434,
    ssl: { ca: "test CA", rejectUnauthorized: true },
    options: "-c timezone=UTC",
  });
});

test("readiness refuses any legacy row that cannot map completely", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("wagglebot_schema_migrations"))
        return {
          rows: [
            { filename: "20260916130000_create_memory_schema.rb" },
            { filename: "20261006120000_complete_memory_wire_mapping.rb" },
          ],
        };
      if (sql.includes("wagglebot_memory_schema_metadata")) return { rows: [metadata] };
      if (sql.includes("wagglebot_memories")) return { rows: [{ id: "bad", scopes: ["component:api"] }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await expect(assertReady(pool as never)).rejects.toThrow(/unsupported legacy memory row/i);
});
