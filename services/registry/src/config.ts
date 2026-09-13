import { z } from "zod";

export type RegistryConfig = {
  bindHost: string;
  port: number;
  issuer: string;
  companyRoot: string;
  sourceRevision: string;
  refreshSeconds: number;
  maxResponseBytes: number;
};

const envSchema = z
  .object({
    REGISTRY_HOST: z.string().min(1).max(253),
    REGISTRY_PORT: z.string().regex(/^\d+$/),
    REGISTRY_ISSUER: z.string().url().startsWith("https://"),
    REGISTRY_COMPANY_ROOT: z.string().min(1),
    REGISTRY_SOURCE_REVISION: z.string().regex(/^[a-f0-9]{40}$/),
    REGISTRY_REFRESH_SECONDS: z.string().regex(/^\d+$/),
    REGISTRY_MAX_RESPONSE_BYTES: z.string().regex(/^\d+$/),
  })
  .strict();

export function loadRegistryConfig(env: Record<string, string | undefined>): RegistryConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${String(issue?.path[0] ?? "registry configuration")}: ${issue?.message ?? "invalid value"}`);
  }
  const port = Number(parsed.data.REGISTRY_PORT);
  const refreshSeconds = Number(parsed.data.REGISTRY_REFRESH_SECONDS);
  const maxResponseBytes = Number(parsed.data.REGISTRY_MAX_RESPONSE_BYTES);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("REGISTRY_PORT: must be 1..65535");
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 1 || refreshSeconds > 86_400)
    throw new Error("REGISTRY_REFRESH_SECONDS: must be 1..86400");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1_048_576)
    throw new Error("REGISTRY_MAX_RESPONSE_BYTES: must be 1..1048576");
  return {
    bindHost: parsed.data.REGISTRY_HOST,
    port,
    issuer: parsed.data.REGISTRY_ISSUER,
    companyRoot: parsed.data.REGISTRY_COMPANY_ROOT,
    sourceRevision: parsed.data.REGISTRY_SOURCE_REVISION,
    refreshSeconds,
    maxResponseBytes,
  };
}
