import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow, types } from "pg";
import { EMBEDDING_PROFILE, readConfig, type WorkerConfig } from "./config";
import { decodeMemoryRecord } from "./record-mapping";

const manifestPath = fileURLToPath(new URL("../../database/migration-version.json", import.meta.url));
let defaultPool: Pool | undefined;

export function poolOptions(config: ReturnType<typeof readConfig>): PoolConfig {
  const url = new URL(config.databaseUrl);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(config.ssl ? { ssl: config.ssl } : {}),
    options: "-c timezone=UTC",
    types: {
      getTypeParser(oid, format) {
        if (oid === 1114) return (value: string) => `${value.replace(" ", "T")}Z`;
        if (oid === 1082) return (value: string) => value;
        return types.getTypeParser(oid, format);
      },
    },
  };
}

function createPool(config: ReturnType<typeof readConfig>): Pool {
  return new Pool(poolOptions(config));
}

function getDefaultPool(): Pool {
  if (!defaultPool) {
    const config = readConfig();
    defaultPool = createPool(config);
  }
  return defaultPool;
}

export type MemoryTransaction = Pick<PoolClient, "query">;
export type MemoryRepository = {
  assertReady(): Promise<void>;
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]>;
  withTransaction<T>(callback: (transaction: MemoryTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: QueryResultRow[] }> };
type ExpectedManifest = { latest: string; migrations: string[] };

function readExpectedManifest(): ExpectedManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ExpectedManifest;
}

class ReadinessError extends Error {}

export async function assertReady(
  database?: Queryable,
  manifest?: ExpectedManifest,
  embeddingProfile = EMBEDDING_PROFILE,
): Promise<void> {
  database ??= getDefaultPool();
  try {
    const expectedManifest = manifest ?? readExpectedManifest();
    if (
      !expectedManifest ||
      !Array.isArray(expectedManifest.migrations) ||
      expectedManifest.migrations.length === 0 ||
      expectedManifest.latest !== expectedManifest.migrations.at(-1)?.slice(0, 14)
    ) {
      throw new ReadinessError("memory worker migration manifest is invalid; verify the shipped database manifest");
    }
    const history = await database.query("SELECT filename FROM wagglebot_schema_migrations ORDER BY filename");
    const filenames = history.rows.map((row) => row.filename);
    if (JSON.stringify(filenames) !== JSON.stringify(expectedManifest.migrations)) {
      throw new ReadinessError(
        "database migration history does not match the shipped manifest; run the database migration job",
      );
    }

    const profileResult = await database.query(
      "SELECT provider, model, dimension, distance, schema_version FROM wagglebot_memory_schema_metadata ORDER BY provider",
    );
    const profiles = profileResult.rows;
    if (
      profiles.length !== 1 ||
      profiles[0]?.provider !== embeddingProfile.provider ||
      profiles[0]?.model !== embeddingProfile.model ||
      profiles[0]?.dimension !== embeddingProfile.dimension ||
      profiles[0]?.distance !== embeddingProfile.distance ||
      profiles[0]?.schema_version !== 1
    ) {
      throw new ReadinessError(
        "database embedding profile does not match this worker; re-embed memories with the configured profile before starting",
      );
    }

    const memories = await database.query("SELECT * FROM wagglebot_memories ORDER BY id");
    for (const row of memories.rows) {
      try {
        decodeMemoryRecord(row);
      } catch {
        const id =
          typeof row.id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)
            ? row.id
            : "[invalid ID]";
        throw new ReadinessError(
          `unsupported legacy memory row ${id}; map its scope, lifecycle, and fields to the supported memory contract before starting`,
        );
      }
    }
  } catch (error) {
    if (error instanceof ReadinessError) throw error;
    throw new Error(
      "memory database readiness check failed; verify migrations, memory metadata, and database availability",
    );
  }
}

async function transact<T>(database: Pool, callback: (transaction: MemoryTransaction) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function withTransaction<T>(callback: (transaction: MemoryTransaction) => Promise<T>): Promise<T> {
  return transact(getDefaultPool(), callback);
}

export function createMemoryRepository(config: WorkerConfig = readConfig()): MemoryRepository {
  const database = createPool(config);
  let closePromise: Promise<void> | undefined;
  return {
    assertReady: () => assertReady(database, undefined, config.embeddingProfile),
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) =>
      (await database.query<T>(sql, values)).rows,
    withTransaction: (callback) => transact(database, callback),
    close: () => {
      closePromise ??= database.end();
      return closePromise;
    },
  };
}

export function decodeQueryRows<T extends QueryResultRow>(rows: T[]) {
  return rows.map(decodeMemoryRecord);
}

export function memoryPool(): Pool {
  return getDefaultPool();
}
