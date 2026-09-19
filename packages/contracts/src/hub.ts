import { z } from "zod";
import type { ProxyConfigSchema, RegistrySnapshotSchema, ToolCatalogSchema } from "./registry";

export const HubConfigSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    bearerToken: z.string().min(32).max(4096),
    configPath: z.string().min(1).optional(),
    configUrl: z.string().url().startsWith("https://").optional(),
    configRefreshSeconds: z.number().int().min(0).max(86_400).default(900),
    trustPath: z.string().min(1),
    toolCatalogPath: z.string().min(1).optional(),
    startupStrict: z.boolean().default(false),
    listToolsCacheTtlSeconds: z.number().int().min(0).max(86_400).default(30),
    codeModeEnabled: z.boolean().default(true),
    warmupToolsOnStartup: z.boolean().default(true),
    toolRefreshEnabled: z.boolean().default(true),
    toolRefreshIntervalSeconds: z.number().int().min(1).max(86_400).default(300),
    toolRetrySeconds: z.number().int().min(1).max(86_400).default(30),
    toolTimeoutSeconds: z.number().int().min(1).max(300).default(5),
    toolMaxConcurrency: z.number().int().min(1).max(32).default(4),
    logFingerprintKey: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.configPath === undefined && value.configUrl === undefined)
      ctx.addIssue({ code: "custom", message: "a registry config path or URL is required" });
    if (value.configPath !== undefined && !value.configPath.startsWith("/"))
      ctx.addIssue({ code: "custom", path: ["configPath"], message: "configPath must be absolute" });
  });

export const DiscoveryStateSchema = z
  .object({
    status: z.enum(["unknown", "refreshing", "ready", "empty", "error"]),
    toolCount: z.number().int().nonnegative().max(10_000),
    tools: z.array(z.unknown()).max(10_000),
    lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
    lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
    lastDiscoveryError: z.string().max(1024).nullable(),
    consecutiveFailures: z.number().int().nonnegative().max(1000),
    nextRetryAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const TrustRecordSchema = z
  .object({
    namespace: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    privilegedKinds: z.array(z.enum(["command", "package", "credential", "origin", "private_target"])).max(5),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const HubErrorCodeSchema = z.enum([
  "hub_invalid_request",
  "hub_auth_required",
  "hub_auth_invalid",
  "hub_tool_unavailable",
  "hub_namespace_unavailable",
  "hub_upstream_timeout",
  "hub_upstream_invalid_response",
  "hub_response_too_large",
  "hub_internal",
]);
export const CodeModeExecuteInputSchema = z
  .object({
    tool: z.string().regex(/^[a-z0-9][a-z0-9-]*_[a-z0-9][a-z0-9_.-]*$/),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type HubConfig = z.infer<typeof HubConfigSchema>;
export type DiscoveryState = z.infer<typeof DiscoveryStateSchema>;
export type TrustRecord = z.infer<typeof TrustRecordSchema>;
export type HubErrorCode = z.infer<typeof HubErrorCodeSchema>;
export type CodeModeExecuteInput = z.infer<typeof CodeModeExecuteInputSchema>;
export type HubRegistryInput = z.infer<typeof RegistrySnapshotSchema>;
export type HubProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type HubToolCatalog = z.infer<typeof ToolCatalogSchema>;
