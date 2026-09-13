import { z } from "zod";
import { UsernameSchema } from "./auth";
import { FullGitShaSchema, Rfc3339TimestampSchema } from "./base";

const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const text = z.string().min(1).max(32_768);
const expansion = z.string().regex(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/);
const boundedStringMap = (value: z.ZodTypeAny, limit: number) =>
  z.record(z.string().min(1).max(256), value).superRefine((record, ctx) => {
    if (Object.keys(record).length > limit)
      ctx.addIssue({ code: "custom", message: `must contain at most ${limit} entries` });
  });
const stringMap = boundedStringMap(z.string().max(4096), 64);

export const CredentialSourceSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("env"), var: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ from: z.literal("file"), path: z.string().min(1).max(1024) }).strict(),
]);

const bearerScheme = z.object({ kind: z.literal("bearer") }).strict();
const basicScheme = z.object({ kind: z.literal("basic") }).strict();
const noneScheme = z.object({ kind: z.literal("none") }).strict();
const headerScheme = z
  .object({ kind: z.literal("header"), name: z.string().min(1).max(256), prefix: z.string().max(256).optional() })
  .strict();
const envScheme = z.object({ kind: z.literal("env"), map: stringMap }).strict();

export const AuthSchemeSchema = z.discriminatedUnion("kind", [
  noneScheme,
  bearerScheme,
  headerScheme,
  basicScheme,
  envScheme,
]);

const proxyBase = z
  .object({
    namespace: name,
    mode: z.enum(["remote_http", "remote_sse", "stdio_npx", "stdio_cmd"]),
    endpoint: z.string().url().max(2048).optional(),
    command: z.string().min(1).max(1024).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), expansion).optional(),
    auth: z.object({ scheme: AuthSchemeSchema, source: CredentialSourceSchema }).strict().optional(),
  })
  .strict()
  .superRefine((proxy, ctx) => {
    const remote = proxy.mode === "remote_http" || proxy.mode === "remote_sse";
    if (remote) {
      if (proxy.endpoint === undefined || !proxy.endpoint.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["endpoint"], message: "an absolute HTTPS endpoint is required" });
      }
    } else if (proxy.command === undefined) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "a command is required" });
    }
    if (
      proxy.mode === "stdio_npx" &&
      proxy.command !== undefined &&
      !/@\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(proxy.command)
    ) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "stdio_npx requires an exact pinned package" });
    }
    if (proxy.auth !== undefined) {
      const kind = proxy.auth.scheme.kind;
      if (kind === "env" && remote) {
        ctx.addIssue({ code: "custom", path: ["auth", "scheme"], message: "env auth requires a stdio mode" });
      }
      if (!remote && (kind === "bearer" || kind === "header" || kind === "basic")) {
        ctx.addIssue({ code: "custom", path: ["auth", "scheme"], message: "remote auth requires a remote mode" });
      }
    }
  });

export const ProxyConfigSchema = proxyBase;

const family = z
  .object({
    id: name,
    title: text.max(512),
    namespace_patterns: z.array(z.string().min(1).max(256)).max(64),
    transport: z.enum(["remote_http", "remote_sse", "stdio_npx", "stdio_cmd"]).optional(),
    tool_prefixes: z.array(name).max(64).default([]),
    summary: text.optional(),
    use_for: z.array(text.max(512)).max(32).default([]),
    start_with: z.array(text.max(512)).max(32).default([]),
    avoid: z.array(text.max(512)).max(32).default([]),
    domain_notes: z.array(text.max(512)).max(32).default([]),
    examples: z.array(text.max(512)).max(32).default([]),
    routing_phrases: z.array(text.max(256)).max(64).default([]),
    routing_keywords: z.array(name).max(64).default([]),
  })
  .strict();

export const ToolCatalogSchema = z
  .object({
    version: z.literal(1),
    title: text.max(512),
    overview: text.optional(),
    platform_context: z.array(text.max(512)).max(64).default([]),
    operating_principles: z.array(text.max(512)).max(64).default([]),
    families: z.array(family).max(256),
  })
  .strict();

export const RegistrySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().regex(/^reg_[a-f0-9]{64}$/),
    sourceRevision: FullGitShaSchema,
    generatedAt: Rfc3339TimestampSchema,
    principal: z.object({ username: UsernameSchema }).strict(),
    proxies: z.array(ProxyConfigSchema).max(256),
    toolCatalog: ToolCatalogSchema,
  })
  .strict();

export const RegistryErrorCodeSchema = z.enum([
  "registry_invalid",
  "registry_unavailable",
  "registry_response_too_large",
  "auth_required",
  "auth_invalid",
]);

export type AuthScheme = z.infer<typeof AuthSchemeSchema>;
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ToolCatalog = z.infer<typeof ToolCatalogSchema>;
export type RegistrySnapshot = z.infer<typeof RegistrySnapshotSchema>;
export type RegistryErrorCode = z.infer<typeof RegistryErrorCodeSchema>;
