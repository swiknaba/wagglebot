import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export const EMBEDDING_PROFILE = {
  provider: "xenova-transformers",
  model: "all-MiniLM-L6-v2",
  modelId: "Xenova/all-MiniLM-L6-v2",
  dimension: 384,
  distance: "cosine",
} as const;

export type WorkerConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  issuer: string;
  companyRoot: string;
  sessionTokenPublicKeyFile: string;
  modelCacheDir: string;
  gitleaksExecutable: string;
  gitleaksSha256: string;
  adminBearerToken: string;
  publicationRepositoriesFile: string;
  publicationRepositories: Record<string, string>;
  ssl?: { ca: string; rejectUnauthorized: true };
  embeddingProfile: typeof EMBEDDING_PROFILE;
};

function requiredAbsolutePath(environment: Record<string, string | undefined>, key: string): string {
  const value = environment[key]?.trim();
  if (!value || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return value;
}

export function readTrustedPublicationRepositories(path: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("MEMORY_PUBLICATION_REPOSITORIES_FILE is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("MEMORY_PUBLICATION_REPOSITORIES_FILE must contain a repository map");
  const repositories = Object.create(null) as Record<string, string>;
  for (const [identity, checkout] of Object.entries(value)) {
    if (!identity || typeof checkout !== "string" || !isAbsolute(checkout))
      throw new Error("MEMORY_PUBLICATION_REPOSITORIES_FILE contains an invalid checkout");
    try {
      if (lstatSync(checkout).isSymbolicLink() || !lstatSync(checkout).isDirectory()) throw new Error("invalid");
      repositories[identity] = realpathSync(checkout);
    } catch {
      throw new Error("MEMORY_PUBLICATION_REPOSITORIES_FILE contains an unavailable checkout");
    }
  }
  if (Object.keys(repositories).length === 0)
    throw new Error("MEMORY_PUBLICATION_REPOSITORIES_FILE must contain at least one checkout");
  return repositories;
}

export function readConfig(
  environment: Record<string, string | undefined> = process.env,
  readCa: (path: string) => string = (path) => readFileSync(path, "utf8"),
  readRepositories: (path: string) => Record<string, string> = readTrustedPublicationRepositories,
): WorkerConfig {
  const databaseUrl = environment.MEMORY_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("MEMORY_DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("MEMORY_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("MEMORY_DATABASE_URL must use PostgreSQL");
  }
  const issuer = environment.MEMORY_ISSUER?.trim();
  if (!issuer) throw new Error("MEMORY_ISSUER must be an HTTPS URL");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error("MEMORY_ISSUER must be an HTTPS URL");
  }
  if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password)
    throw new Error("MEMORY_ISSUER must be an HTTPS URL");
  const companyRoot = requiredAbsolutePath(environment, "MEMORY_COMPANY_ROOT");
  const sessionTokenPublicKeyFile = requiredAbsolutePath(environment, "MEMORY_SESSION_TOKEN_PUBLIC_KEY_FILE");
  const modelCacheDir = requiredAbsolutePath(environment, "MEMORY_MODEL_CACHE_DIR");
  const gitleaksExecutable = requiredAbsolutePath(environment, "MEMORY_GITLEAKS_EXECUTABLE");
  const gitleaksSha256 = environment.MEMORY_GITLEAKS_SHA256?.trim() ?? "";
  if (!/^[a-f0-9]{64}$/iu.test(gitleaksSha256))
    throw new Error("MEMORY_GITLEAKS_SHA256 must be a 64-character hexadecimal digest");
  const adminBearerToken = environment.MEMORY_ADMIN_BEARER_TOKEN;
  if (!adminBearerToken?.trim()) throw new Error("MEMORY_ADMIN_BEARER_TOKEN is required");
  const publicationRepositoriesFile = requiredAbsolutePath(environment, "MEMORY_PUBLICATION_REPOSITORIES_FILE");
  const publicationRepositories = readRepositories(publicationRepositoriesFile);
  const allowedParameters = new Set(["sslmode", "sslrootcert"]);
  const parameterNames = [...url.searchParams.keys()];
  const lowerNames = parameterNames.map((key) => key.toLowerCase());
  const seenParameters = new Set<string>();
  if (
    parameterNames.some((key) => key !== key.toLowerCase() || !allowedParameters.has(key.toLowerCase())) ||
    lowerNames.some((key) => {
      if (seenParameters.has(key)) return true;
      seenParameters.add(key);
      return false;
    })
  ) {
    throw new Error("MEMORY_DATABASE_URL contains unsupported connection string options");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const databaseHost = url.hostname.replace(/^\[|\]$/g, "");
  let ssl: WorkerConfig["ssl"];
  if (!localHosts.has(databaseHost)) {
    if (url.searchParams.get("sslmode") !== "verify-full") {
      throw new Error("remote MEMORY_DATABASE_URL requires sslmode=verify-full");
    }
    const caPath = environment.MEMORY_DATABASE_CA ?? url.searchParams.get("sslrootcert") ?? undefined;
    if (!caPath) throw new Error("remote MEMORY_DATABASE_URL requires MEMORY_DATABASE_CA or sslrootcert");
    try {
      ssl = { ca: readCa(caPath), rejectUnauthorized: true };
    } catch {
      throw new Error("memory database CA file could not be read");
    }
  }
  url.search = "";
  const rawPort = environment.MEMORY_PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("MEMORY_PORT must be an integer from 1 to 65535");
  const host = environment.MEMORY_HOST?.trim() || "0.0.0.0";
  if (/[\s/]/.test(host)) throw new Error("MEMORY_HOST must be a valid bind host");
  return {
    databaseUrl: url.toString(),
    host,
    port,
    issuer,
    companyRoot,
    sessionTokenPublicKeyFile,
    modelCacheDir,
    gitleaksExecutable,
    gitleaksSha256: gitleaksSha256.toLowerCase(),
    adminBearerToken,
    publicationRepositoriesFile,
    publicationRepositories,
    ...(ssl ? { ssl } : {}),
    embeddingProfile: EMBEDDING_PROFILE,
  };
}
