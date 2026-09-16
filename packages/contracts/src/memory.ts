import { z } from "zod";
import {
  FullGitShaSchema,
  ProvenanceSchema,
  RelativePathSchema,
  Rfc3339TimestampSchema,
  Sha256Schema,
  SharedScopeSchema,
} from "./base";

export { SharedScopeSchema } from "./base";

const boundedUnicodeString = (maximum: number) =>
  z.string().superRefine((value, context) => {
    const codePointCount = [...value].length;
    if (codePointCount === 0) {
      context.addIssue({
        code: "too_small",
        origin: "string",
        minimum: 1,
        inclusive: true,
        message: "text is required",
      });
    } else if (codePointCount > maximum) {
      context.addIssue({
        code: "too_big",
        origin: "string",
        maximum,
        inclusive: true,
        message: `text must be at most ${maximum} Unicode code points`,
      });
    }
  });

const safeName = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const operationKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.uuid();
const reviewAfter = z.iso.date();
const memoryKind = z.enum(["fact", "decision", "warning", "convention", "interface", "runbook"]);
const confidence = z.enum(["low", "medium", "high"]);
const memoryStatus = z.enum(["active", "superseded", "invalidated"]);
const provenance = z.array(ProvenanceSchema).min(1);

const withWakeReview = <T extends { wake?: boolean; reviewAfter?: string }>(
  value: T,
  context: z.RefinementCtx,
): void => {
  if (value.wake === true && value.reviewAfter === undefined) {
    context.addIssue({ code: "custom", path: ["reviewAfter"], message: "reviewAfter is required when wake is true" });
  }
};

const memoryRecord = z
  .object({
    id: uuid,
    schemaVersion: z.literal(1),
    scope: SharedScopeSchema,
    kind: memoryKind,
    title: boundedUnicodeString(200),
    content: boundedUnicodeString(4_000),
    canonicalKey: z.string().min(1),
    identityKey: z.string().min(1),
    contentHash: Sha256Schema,
    confidence,
    status: memoryStatus,
    wake: z.boolean().default(false),
    reviewAfter: reviewAfter.optional(),
    provenance,
    supersedes: uuid.optional(),
    supersededBy: uuid.optional(),
    createdAt: Rfc3339TimestampSchema,
    updatedAt: Rfc3339TimestampSchema,
  })
  .strict()
  .superRefine(withWakeReview);

export const MemoryKindSchema = memoryKind;
export const MemoryConfidenceSchema = confidence;
export const MemoryStatusSchema = memoryStatus;
export const MemoryRecordSchema = memoryRecord;

const queryCascade = z
  .object({
    component: safeName.optional(),
    system: safeName,
    domain: safeName.optional(),
    includeOrg: z.literal(true),
  })
  .strict();

const wakeCascade = z
  .object({
    system: safeName,
    domain: safeName.optional(),
    includeOrg: z.literal(true),
  })
  .strict();

const memoryQueryInput = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("query"),
    query: boundedUnicodeString(2_000),
    cascade: queryCascade,
    scopes: z.array(SharedScopeSchema).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const memoryWakeInput = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("wake"),
    cascade: wakeCascade,
    limit: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
  })
  .strict();

export const MemorySearchInputSchema = z.discriminatedUnion("purpose", [memoryQueryInput, memoryWakeInput]);

const score = z.number().finite().min(0).max(1);

export const MemorySearchResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z
      .array(
        z
          .object({
            record: memoryRecord,
            score,
          })
          .strict(),
      )
      .max(20),
    additionalEligible: z.number().int().nonnegative().optional(),
  })
  .strict();

const writeOutcome = z
  .object({
    recordId: uuid,
    outcome: z.enum(["created", "merged", "superseded", "unchanged", "rejected"]),
    code: z.string().min(1).optional(),
  })
  .strict();

export const WriteResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    outcomes: z.array(writeOutcome).min(1).max(20),
  })
  .strict();

const systemScope = z.object({ kind: z.literal("system"), name: safeName }).strict();

const proposalFact = z
  .object({
    scope: systemScope,
    kind: memoryKind,
    title: boundedUnicodeString(200),
    content: boundedUnicodeString(4_000),
    confidence,
    provenance,
    confirmedBy: safeName,
    confirmedAt: Rfc3339TimestampSchema,
  })
  .strict();

export const MemoryProposalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    facts: z.array(proposalFact).min(1).max(20),
  })
  .strict();

const rememberRequest = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    scope: SharedScopeSchema,
    kind: memoryKind,
    title: boundedUnicodeString(200),
    content: boundedUnicodeString(4_000),
    confidence,
    wake: z.boolean().default(false),
    reviewAfter: reviewAfter.optional(),
    provenance,
  })
  .strict();

export const RememberRequestSchema = rememberRequest.superRefine(withWakeReview);

export const InvalidateRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    reason: boundedUnicodeString(200),
  })
  .strict();

const publicationChunk = z
  .object({
    chunkKey: z.string().min(1),
    heading: boundedUnicodeString(200),
    kind: memoryKind,
    title: boundedUnicodeString(200),
    content: boundedUnicodeString(4_000),
    confidence,
    wake: z.boolean().default(false),
    reviewAfter: reviewAfter.optional(),
    provenance,
  })
  .strict()
  .superRefine(withWakeReview);

export const PublicationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    revision: FullGitShaSchema,
    repository: z.string().min(1),
    path: RelativePathSchema,
    scope: SharedScopeSchema,
    owner: safeName,
    chunks: z.array(publicationChunk).min(1).max(256),
  })
  .strict();

export const InvalidateResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    recordId: uuid,
    status: z.literal("invalidated"),
  })
  .strict();

export const GetMemoryResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    record: memoryRecord,
  })
  .strict();

export const PublicationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationKey,
    sourceKey: z.string().min(1),
    revision: FullGitShaSchema,
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    invalidated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  })
  .strict();

export const MemoryErrorCodeSchema = z.enum([
  "memory_invalid",
  "unknown_scope",
  "confirmation_required",
  "auth_required",
  "auth_invalid",
  "agent_scope_forbidden",
  "agent_wake_forbidden",
  "operation_key_conflict",
  "request_too_large",
  "secret_rejected",
  "memory_unavailable",
  "scanner_unavailable",
  "domain_owner_required",
  "org_owner_required",
  "lower_confidence_conflict",
  "memory_not_found",
  "memory_forbidden",
  "source_revision_regressed",
  "publication_invalid",
  "admin_auth_required",
  "admin_auth_invalid",
  "embedding_profile_invalid",
  "provider_unavailable",
]);

export const MemoryErrorEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    error: z
      .object({
        code: MemoryErrorCodeSchema,
        message: z.string().min(1),
        correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

const adminOperation = z.object({ schemaVersion: z.literal(1), operationKey }).strict();

export const AdminRescanRequestSchema = adminOperation;
export const AdminReindexRequestSchema = adminOperation.extend({ profileId: uuid.optional() }).strict();
export const AdminRunOnceRequestSchema = adminOperation
  .extend({ limit: z.number().int().min(1).max(100).default(100) })
  .strict();

export const AdminRescanResponseSchema = adminOperation
  .extend({
    operationId: z.string().min(1),
    scanned: z.number().int().nonnegative(),
    invalidated: z.number().int().nonnegative(),
    ruleIds: z.array(z.string().min(1)),
  })
  .strict();

export const AdminReindexResponseSchema = adminOperation
  .extend({ operationId: z.string().min(1), queued: z.number().int().nonnegative() })
  .strict();

export const AdminRunOnceResponseSchema = adminOperation
  .extend({
    operationId: z.string().min(1),
    claimed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

export const MemorySearchMcpInputSchema = z.discriminatedUnion("purpose", [
  memoryQueryInput.omit({ schemaVersion: true }),
  memoryWakeInput.omit({ schemaVersion: true }),
]);
export const MemoryQueryMcpInputSchema = z.object({ id: uuid }).strict();
export const MemoryProposalMcpInputSchema = MemoryProposalRequestSchema.omit({ schemaVersion: true });
export const RememberMcpInputSchema = rememberRequest.omit({ schemaVersion: true }).superRefine(withWakeReview);
export const ForgetMcpInputSchema = InvalidateRequestSchema.omit({ schemaVersion: true }).extend({ id: uuid }).strict();

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
export type WriteResult = z.infer<typeof WriteResultSchema>;
export type MemoryProposalRequest = z.infer<typeof MemoryProposalRequestSchema>;
export type RememberRequest = z.infer<typeof RememberRequestSchema>;
export type InvalidateRequest = z.infer<typeof InvalidateRequestSchema>;
export type PublicationRequest = z.infer<typeof PublicationRequestSchema>;
export type InvalidateResponse = z.infer<typeof InvalidateResponseSchema>;
export type GetMemoryResponse = z.infer<typeof GetMemoryResponseSchema>;
export type PublicationResponse = z.infer<typeof PublicationResponseSchema>;
export type MemoryErrorCode = z.infer<typeof MemoryErrorCodeSchema>;
export type MemoryErrorEnvelope = z.infer<typeof MemoryErrorEnvelopeSchema>;
export type AdminRescanRequest = z.infer<typeof AdminRescanRequestSchema>;
export type AdminReindexRequest = z.infer<typeof AdminReindexRequestSchema>;
export type AdminRunOnceRequest = z.infer<typeof AdminRunOnceRequestSchema>;
export type AdminRescanResponse = z.infer<typeof AdminRescanResponseSchema>;
export type AdminReindexResponse = z.infer<typeof AdminReindexResponseSchema>;
export type AdminRunOnceResponse = z.infer<typeof AdminRunOnceResponseSchema>;
export type MemorySearchMcpInput = z.infer<typeof MemorySearchMcpInputSchema>;
export type MemoryQueryMcpInput = z.infer<typeof MemoryQueryMcpInputSchema>;
export type MemoryProposalMcpInput = z.infer<typeof MemoryProposalMcpInputSchema>;
export type RememberMcpInput = z.infer<typeof RememberMcpInputSchema>;
export type ForgetMcpInput = z.infer<typeof ForgetMcpInputSchema>;
