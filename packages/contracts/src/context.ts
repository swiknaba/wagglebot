import { z } from "zod";
import {
  EvidenceRefSchema,
  FullGitShaSchema,
  PacketMetadataSchema,
  ProjectIdentitySchema,
  ProviderFailureSchema,
  RelativePathSchema,
  Rfc3339TimestampSchema,
} from "./base";

export const CONTEXT_TOKEN_LIMITS = {
  wakeL0: { default: 100, hardMax: 150 },
  wakeL1: { default: 350, hardMax: 500 },
  wakeL2: { default: 800, hardMax: 1_500 },
  wakeL3: { default: 3_000, hardMax: 5_000 },
  search: { default: 800, hardMax: 1_500 },
  explain: { default: 1_200, hardMax: 2_500 },
} as const;

const providerSchema = ProviderFailureSchema.shape.provider;
const providerFailureCodeSchema = ProviderFailureSchema.shape.code;
const contextModeSchema = z.enum(["wake", "search", "explain"]);
const responseFormatSchema = z.enum(["markdown", "structured"]);
const sourceSchema = providerSchema;
const cursorSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const projectPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "absolute projectPath is required");
const queryTextSchema = z.string().superRefine((text, context) => {
  if (text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "text must not be empty or whitespace" });
  }
  if (Array.from(text).length > 2_000) {
    context.addIssue({ code: "custom", message: "text exceeds 2,000 Unicode code points" });
  }
});
const tokenCountSchema = z.number().int().positive();
const remainingContextTokensSchema = z.number().int().positive();
const levelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const wakeLimitFor = (level: 0 | 1 | 2 | 3 | undefined) => {
  switch (level ?? 0) {
    case 0:
      return CONTEXT_TOKEN_LIMITS.wakeL0.hardMax;
    case 1:
      return CONTEXT_TOKEN_LIMITS.wakeL1.hardMax;
    case 2:
      return CONTEXT_TOKEN_LIMITS.wakeL2.hardMax;
    case 3:
      return CONTEXT_TOKEN_LIMITS.wakeL3.hardMax;
  }
};
const providers = ["local_memory", "code", "git", "shared_memory"] as const;

export const ContextCursorSchema = cursorSchema;
export const ContextControlsSchema = z
  .object({
    maxTokens: tokenCountSchema.optional(),
    remainingContextTokens: remainingContextTokensSchema.optional(),
    cursor: cursorSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
  })
  .strict();

const wakeInputBase = z
  .object({
    projectPath: projectPathSchema,
    level: levelSchema.optional(),
    task: queryTextSchema.optional(),
    maxTokens: tokenCountSchema.optional(),
    remainingContextTokens: remainingContextTokensSchema.optional(),
    cursor: cursorSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
  })
  .strict();

export const BrainWakeInputSchema = wakeInputBase.superRefine((input, context) => {
  if (input.maxTokens !== undefined && input.maxTokens > wakeLimitFor(input.level)) {
    context.addIssue({ code: "custom", path: ["maxTokens"], message: "maxTokens exceeds the requested wake level" });
  }
  if ((input.level === 2 || input.level === 3) && input.task === undefined) {
    context.addIssue({ code: "custom", path: ["task"], message: "task is required for L2 and L3 wake" });
  }
});

export const BrainSearchInputSchema = z
  .object({
    projectPath: projectPathSchema,
    query: queryTextSchema,
    sources: z
      .array(sourceSchema)
      .max(providers.length)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    limit: z.number().int().min(1).max(6).optional(),
    maxTokens: tokenCountSchema.max(CONTEXT_TOKEN_LIMITS.search.hardMax).optional(),
    remainingContextTokens: remainingContextTokensSchema.optional(),
    cursor: cursorSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
  })
  .strict();

export const BrainExplainInputSchema = z
  .object({
    projectPath: projectPathSchema,
    query: queryTextSchema.optional(),
    symbol: z.string().min(1).max(500).optional(),
    path: RelativePathSchema.optional(),
    startLine: z.number().int().positive().max(1_000_000).optional(),
    endLine: z.number().int().positive().max(1_000_000).optional(),
    maxTokens: tokenCountSchema.max(CONTEXT_TOKEN_LIMITS.explain.hardMax).optional(),
    remainingContextTokens: remainingContextTokensSchema.optional(),
    cursor: cursorSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.startLine === undefined) !== (input.endLine === undefined)) {
      context.addIssue({ code: "custom", path: ["startLine"], message: "line ranges must include both bounds" });
    }
    if ((input.startLine !== undefined || input.endLine !== undefined) && input.path === undefined) {
      context.addIssue({ code: "custom", path: ["path"], message: "path is required for a line range" });
    }
    if (input.startLine !== undefined && input.endLine !== undefined && input.endLine < input.startLine) {
      context.addIssue({ code: "custom", path: ["endLine"], message: "endLine must not precede startLine" });
    }
    if (
      (input.query === undefined || input.query.trim().length === 0) &&
      (input.symbol === undefined || input.symbol.trim().length === 0) &&
      input.path === undefined
    ) {
      context.addIssue({ code: "custom", message: "query, symbol, or path is required" });
    }
  });

export const BrainStatusInputSchema = z.object({ projectPath: projectPathSchema }).strict();

export const ContextItemSchema = z
  .object({
    id: z.string().min(1),
    source: sourceSchema,
    scope: z.enum(["component", "system", "domain", "org"]).optional(),
    kind: z.string().min(1),
    title: z.string().min(1),
    excerpt: z.string(),
    provenance: z.array(EvidenceRefSchema).min(1),
    freshness: z.enum(["live", "current_revision", "historical", "stale", "unknown"]),
    channelRanks: z.record(z.string().min(1), z.number().int().positive()),
    fusedScore: z.number().finite().nonnegative(),
    authorityTier: z.number().int().min(0).max(100),
  })
  .strict();

export const ContextConflictSchema = z
  .object({
    identityKey: z.string().min(1),
    itemIds: z.array(z.string().min(1)).min(2),
    resolution: z.enum(["current_source_preferred", "reviewed_source_preferred", "unresolved"]),
    reason: z.string().min(1),
  })
  .strict();

export const ContextOmissionReasonSchema = z.enum([
  "budget",
  "duplicate",
  "inactive",
  "stale",
  "provider_limit",
  "item_cap",
  "low_relevance",
  "not_wake_eligible",
  "already_delivered",
  "cursor_reset",
]);

export const ContextOmittedSchema = z
  .object({
    candidates: z.number().int().nonnegative(),
    // Omitted candidates are not part of the response budget and may exceed it.
    estimatedTokens: z.number().int().nonnegative(),
    reasons: z.array(ContextOmissionReasonSchema),
  })
  .strict();

export const ContextFreshnessSchema = z
  .object({
    generatedAt: Rfc3339TimestampSchema,
    gitHead: FullGitShaSchema.optional(),
    branch: z.string().min(1).optional(),
    workingTree: z.enum(["clean", "dirty"]).optional(),
    codeGraph: z.enum(["missing", "ready", "pending", "error"]),
    pendingFiles: z.array(RelativePathSchema),
    sharedRetrievedAt: Rfc3339TimestampSchema.optional(),
  })
  .strict();

const contextRequestSchema = z
  .object({
    query: queryTextSchema.optional(),
    task: queryTextSchema.optional(),
    requestedLevel: levelSchema.optional(),
    requestedMaxTokens: tokenCountSchema.max(CONTEXT_TOKEN_LIMITS.wakeL3.hardMax).optional(),
    remainingContextTokens: remainingContextTokensSchema.optional(),
    effectiveMaxTokens: tokenCountSchema.max(CONTEXT_TOKEN_LIMITS.wakeL3.hardMax),
  })
  .strict();

export const ContextPacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: PacketMetadataSchema.shape.packetId,
    cursor: cursorSchema,
    mode: contextModeSchema,
    request: contextRequestSchema,
    project: ProjectIdentitySchema,
    freshness: ContextFreshnessSchema,
    items: z.array(ContextItemSchema),
    conflicts: z.array(ContextConflictSchema),
    degraded: z.array(ProviderFailureSchema),
    omitted: ContextOmittedSchema,
    estimatedTokens: z.number().int().nonnegative().max(CONTEXT_TOKEN_LIMITS.wakeL3.hardMax),
  })
  .strict()
  .superRefine((packet, context) => {
    const maximum =
      packet.mode === "explain"
        ? CONTEXT_TOKEN_LIMITS.explain.hardMax
        : packet.mode === "search"
          ? CONTEXT_TOKEN_LIMITS.search.hardMax
          : wakeLimitFor(packet.request.requestedLevel);
    if (packet.request.effectiveMaxTokens > maximum) {
      context.addIssue({
        code: "custom",
        path: ["request", "effectiveMaxTokens"],
        message: "effective token budget exceeds the mode maximum",
      });
    }
    if (packet.request.requestedMaxTokens !== undefined && packet.request.requestedMaxTokens > maximum) {
      context.addIssue({
        code: "custom",
        path: ["request", "requestedMaxTokens"],
        message: "requested token budget exceeds the mode maximum",
      });
    }
    if (
      packet.request.requestedMaxTokens !== undefined &&
      packet.request.effectiveMaxTokens > packet.request.requestedMaxTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["request", "effectiveMaxTokens"],
        message: "effective token budget exceeds the requested budget",
      });
    }
    if (
      packet.request.remainingContextTokens !== undefined &&
      packet.request.effectiveMaxTokens > packet.request.remainingContextTokens * 0.05
    ) {
      context.addIssue({
        code: "custom",
        path: ["request", "effectiveMaxTokens"],
        message: "effective token budget exceeds the remaining-context cap",
      });
    }
    if (packet.estimatedTokens > packet.request.effectiveMaxTokens) {
      context.addIssue({
        code: "custom",
        path: ["estimatedTokens"],
        message: "estimatedTokens exceeds the effective budget",
      });
    }
    const sharedItems = packet.items.filter((item) => item.source === "shared_memory").length;
    if (packet.mode === "wake") {
      const level = packet.request.requestedLevel ?? 0;
      const maxItems = level === 0 ? 0 : level === 1 ? 8 : level === 2 ? 6 : 20;
      const maxShared = level === 1 ? 3 : level === 2 ? 3 : level === 3 ? 8 : 0;
      if (packet.items.length > maxItems || sharedItems > maxShared) {
        context.addIssue({ code: "custom", path: ["items"], message: "items exceed the requested wake-level limits" });
      }
      if (level === 1 && packet.items.filter((item) => item.source === "local_memory").length > 2) {
        context.addIssue({ code: "custom", path: ["items"], message: "L1 permits at most two local-memory items" });
      }
      if (level === 1 && packet.items.filter((item) => item.source === "git").length > 3) {
        context.addIssue({ code: "custom", path: ["items"], message: "L1 permits at most three Git titles" });
      }
      if (level === 1 && packet.items.some((item) => item.source === "code")) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "L1 includes CodeGraph status but no code items",
        });
      }
    } else if (packet.mode === "search" && (packet.items.length > 6 || sharedItems > 3)) {
      context.addIssue({ code: "custom", path: ["items"], message: "search items exceed the mode limits" });
    } else if (packet.mode === "explain" && packet.items.length > 8) {
      context.addIssue({ code: "custom", path: ["items"], message: "explain permits at most eight items" });
    }
    if (packet.mode === "wake" && packet.request.query !== undefined) {
      context.addIssue({ code: "custom", path: ["request", "query"], message: "wake requests use task, not query" });
    }
    if (packet.mode !== "wake" && packet.request.requestedLevel !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["request", "requestedLevel"],
        message: "requestedLevel applies only to wake",
      });
    }
    if (packet.mode === "search" && packet.request.task !== undefined) {
      context.addIssue({ code: "custom", path: ["request", "task"], message: "search requests use query, not task" });
    }
    if (packet.mode === "explain" && packet.request.task !== undefined) {
      context.addIssue({ code: "custom", path: ["request", "task"], message: "explain requests use query, not task" });
    }
  });

const statusProviderSchema = z
  .object({
    state: z.enum(["ready", "degraded", "missing", "not_requested"]),
    observedAt: Rfc3339TimestampSchema,
    code: providerFailureCodeSchema.optional(),
  })
  .strict();

export const BrainStatusResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: ProjectIdentitySchema,
    providers: z
      .object({
        local_memory: statusProviderSchema,
        code: statusProviderSchema,
        git: statusProviderSchema,
        shared_memory: statusProviderSchema,
      })
      .strict(),
    freshness: z
      .object({
        generatedAt: Rfc3339TimestampSchema,
        gitHead: FullGitShaSchema.optional(),
        branch: z.string().min(1).optional(),
        workingTree: z.enum(["clean", "dirty"]).optional(),
      })
      .strict(),
    cursorCache: z
      .object({
        entries: z.number().int().nonnegative().max(128),
        maxEntries: z.literal(128),
        ttlSeconds: z.literal(14_400),
      })
      .strict(),
    lastRequestTiming: z
      .object({
        totalMs: z.number().finite().nonnegative(),
        providers: z.record(z.string().min(1), z.number().finite().nonnegative()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ContextMarkdownMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: PacketMetadataSchema.shape.packetId,
    cursor: cursorSchema,
    estimatedTokens: z.number().int().nonnegative().max(CONTEXT_TOKEN_LIMITS.wakeL3.hardMax),
    omitted: z
      .object({ candidates: z.number().int().nonnegative(), estimatedTokens: z.number().int().nonnegative() })
      .strict()
      .optional(),
    degraded: z.array(z.object({ provider: providerSchema, code: providerFailureCodeSchema }).strict()).optional(),
    evidenceHandles: z
      .array(z.object({ itemId: z.string().min(1), handles: z.array(z.string().min(1)) }).strict())
      .optional(),
    conflicts: z
      .array(
        z
          .object({ itemIds: z.array(z.string().min(1)).min(2), resolution: ContextConflictSchema.shape.resolution })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ContextControls = z.infer<typeof ContextControlsSchema>;
export type BrainWakeInput = z.infer<typeof BrainWakeInputSchema>;
export type BrainSearchInput = z.infer<typeof BrainSearchInputSchema>;
export type BrainExplainInput = z.infer<typeof BrainExplainInputSchema>;
export type BrainStatusInput = z.infer<typeof BrainStatusInputSchema>;
export type ContextItem = z.infer<typeof ContextItemSchema>;
export type ContextConflict = z.infer<typeof ContextConflictSchema>;
export type ContextOmitted = z.infer<typeof ContextOmittedSchema>;
export type ContextFreshness = z.infer<typeof ContextFreshnessSchema>;
export type ContextPacket = z.infer<typeof ContextPacketSchema>;
export type BrainStatusResult = z.infer<typeof BrainStatusResultSchema>;
export type ContextMarkdownMetadata = z.infer<typeof ContextMarkdownMetadataSchema>;

export type { EvidenceRef, ProjectIdentity, ProviderFailure } from "./base";
