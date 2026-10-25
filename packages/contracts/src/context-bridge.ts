import { z } from "zod";
import { EvidenceRefSchema, Rfc3339TimestampSchema } from "./base";

const boundedUnicodeString = (max: number) => z.string().refine((value) => Array.from(value).length <= max);
const absoluteProjectPath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"));

export const ContextBridgeScopeSchema = z.enum(["project", "workstation"]);
export const ContextBridgeResponseFormatSchema = z.enum(["structured", "markdown"]);
export const ContextBridgeToolErrorSchema = z.enum([
  "context_invalid",
  "context_expired",
  "context_project_mismatch",
  "context_owner_mismatch",
  "context_limit",
  "context_unavailable",
]);

const bridgeProjectSchema = z
  .object({
    rootKey: z.string().regex(/^rk_[a-f0-9]{32}$/u),
    component: z.string().min(1).max(120).optional(),
    system: z.string().min(1).max(120).optional(),
    branch: z.string().min(1).max(240).optional(),
    head: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/u)
      .optional(),
  })
  .strict();

const bridgeDecisionSchema = z.object({ title: boundedUnicodeString(80), summary: boundedUnicodeString(600) }).strict();
const providerStateSchema = z
  .object({
    localBrain: z.enum(["ready", "degraded", "missing"]),
    sharedMemory: z.enum(["ready", "degraded", "not_requested"]),
  })
  .strict();

export const ContextBridgePacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: z.string().regex(/^cb_pkt_[A-Za-z0-9_-]{20,80}$/u),
    project: bridgeProjectSchema,
    scope: ContextBridgeScopeSchema,
    goal: boundedUnicodeString(300),
    decisions: z.array(bridgeDecisionSchema).max(10),
    openQuestions: z.array(boundedUnicodeString(240)).max(10),
    evidence: z.array(EvidenceRefSchema).max(20),
    providerState: providerStateSchema,
    createdAt: Rfc3339TimestampSchema,
    expiresAt: Rfc3339TimestampSchema,
  })
  .strict()
  .superRefine((packet, context) => {
    if (Date.parse(packet.expiresAt) <= Date.parse(packet.createdAt)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry must follow creation" });
    }
    if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > 16 * 1024) {
      context.addIssue({ code: "custom", message: "packet exceeds 16 KiB" });
    }
  });

export const ContextBridgeExportInputSchema = z
  .object({
    projectPath: absoluteProjectPath,
    scope: ContextBridgeScopeSchema.default("project"),
    goal: boundedUnicodeString(300),
    decisions: z.array(bridgeDecisionSchema).max(10),
    openQuestions: z.array(boundedUnicodeString(240)).max(10),
    evidence: z.array(EvidenceRefSchema).max(20),
    providerState: providerStateSchema,
    ttlSeconds: z.number().int().min(1).max(14_400).optional(),
    responseFormat: ContextBridgeResponseFormatSchema.default("structured"),
  })
  .strict();

const handle = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const ContextBridgeHandleInputSchema = z
  .object({
    handle,
    projectPath: absoluteProjectPath,
    responseFormat: ContextBridgeResponseFormatSchema.default("structured"),
  })
  .strict();
export const ContextBridgeStatusInputSchema = z.object({ projectPath: absoluteProjectPath }).strict();
export const ContextBridgeRevokeInputSchema = z.object({ handle, projectPath: absoluteProjectPath }).strict();

export const ContextBridgePacketMetaSchema = z
  .object({
    packetId: ContextBridgePacketSchema.shape.packetId,
    scope: ContextBridgeScopeSchema,
    project: z
      .object({
        component: z.string().min(1).optional(),
        system: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        head: z
          .string()
          .regex(/^[0-9a-f]{7,64}$/u)
          .optional(),
      })
      .strict(),
    createdAt: Rfc3339TimestampSchema,
    expiresAt: Rfc3339TimestampSchema,
  })
  .strict();

export const ContextBridgeExportResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    handle,
    packetMeta: ContextBridgePacketMetaSchema,
    packet: ContextBridgePacketSchema,
  })
  .strict();
export const ContextBridgeImportResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    importedContext: ContextBridgePacketSchema,
    packetMeta: ContextBridgePacketMetaSchema,
  })
  .strict();
export const ContextBridgeStatusResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetCount: z.number().int().nonnegative().max(32),
    packets: z
      .array(
        z
          .object({ ...ContextBridgePacketMetaSchema.shape, importCount: z.number().int().nonnegative().max(8) })
          .strict(),
      )
      .max(32),
  })
  .strict();
export const ContextBridgeRevokeResultSchema = z
  .object({ schemaVersion: z.literal(1), revoked: z.literal(true) })
  .strict();

export type ContextBridgeScope = z.infer<typeof ContextBridgeScopeSchema>;
export type ContextBridgePacket = z.infer<typeof ContextBridgePacketSchema>;
export type ContextBridgeExportInput = z.input<typeof ContextBridgeExportInputSchema>;
export type ContextBridgeHandleInput = z.input<typeof ContextBridgeHandleInputSchema>;
export type ContextBridgeStatusInput = z.infer<typeof ContextBridgeStatusInputSchema>;
export type ContextBridgeRevokeInput = z.infer<typeof ContextBridgeRevokeInputSchema>;
export type ContextBridgePacketMeta = z.infer<typeof ContextBridgePacketMetaSchema>;
export type ContextBridgeExportResult = z.infer<typeof ContextBridgeExportResultSchema>;
export type ContextBridgeImportResult = z.infer<typeof ContextBridgeImportResultSchema>;
export type ContextBridgeStatusResult = z.infer<typeof ContextBridgeStatusResultSchema>;
export type ContextBridgeRevokeResult = z.infer<typeof ContextBridgeRevokeResultSchema>;
