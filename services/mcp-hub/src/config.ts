import { homedir } from "node:os";
import { type HubConfig, HubConfigSchema } from "@wagglebot/contracts";

const number = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value);
export function loadHubConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const raw = {
    host: env.MCP_HUB_HOST ?? "127.0.0.1",
    port: number(env.MCP_HUB_PORT, 9000),
    bearerToken: env.MCP_HUB_BEARER_TOKEN ?? "",
    ...(env.MCP_HUB_CONFIG_PATH ? { configPath: env.MCP_HUB_CONFIG_PATH } : {}),
    ...(env.MCP_HUB_CONFIG_URL ? { configUrl: env.MCP_HUB_CONFIG_URL } : {}),
    configRefreshSeconds: number(env.MCP_HUB_CONFIG_REFRESH_SECONDS, 900),
    trustPath: env.MCP_HUB_TRUST_PATH ?? `${homedir()}/.wagglebot/mcp-hub/registry.trust.json`,
    ...(env.MCP_HUB_TOOL_CATALOG_PATH ? { toolCatalogPath: env.MCP_HUB_TOOL_CATALOG_PATH } : {}),
    startupStrict: env.MCP_HUB_STARTUP_STRICT === "1",
    listToolsCacheTtlSeconds: number(env.MCP_HUB_LIST_TOOLS_CACHE_TTL_SECONDS, 30),
    codeModeEnabled: env.MCP_HUB_CODE_MODE !== "0",
    warmupToolsOnStartup: env.MCP_HUB_WARMUP_TOOLS !== "0",
    toolRefreshEnabled: env.MCP_HUB_TOOL_REFRESH !== "0",
    toolRefreshIntervalSeconds: number(env.MCP_HUB_TOOL_REFRESH_INTERVAL_SECONDS, 300),
    toolRetrySeconds: number(env.MCP_HUB_TOOL_RETRY_SECONDS, 30),
    toolTimeoutSeconds: number(env.MCP_HUB_TOOL_TIMEOUT_SECONDS, 5),
    toolMaxConcurrency: number(env.MCP_HUB_TOOL_MAX_CONCURRENCY, 4),
    ...(env.MCP_HUB_LOG_FINGERPRINT_KEY ? { logFingerprintKey: env.MCP_HUB_LOG_FINGERPRINT_KEY } : {}),
  };
  const parsed = HubConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`invalid MCP hub configuration: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
  return parsed.data;
}
