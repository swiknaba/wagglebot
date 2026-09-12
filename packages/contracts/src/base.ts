import { z } from "zod";

const MAX_EVIDENCE_LINE_NUMBER = 1_000_000;
const MAX_RFC3339_TIMESTAMP_LENGTH = 64;

const safeName = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const nonEmptyText = z.string().min(1);
const fullGitSha = z.string().regex(/^[a-f0-9]{40}$/);
const evidenceGitSha = z.string().regex(/^[a-f0-9]{7,64}$/);

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const FullGitShaSchema = fullGitSha;
export const GitShaSchema = evidenceGitSha;
export const Rfc3339TimestampSchema = z.iso.datetime({ offset: true }).max(MAX_RFC3339_TIMESTAMP_LENGTH);

const evidenceLineNumber = z.number().int().positive().max(MAX_EVIDENCE_LINE_NUMBER);

export const RelativePathSchema = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    if (path.includes("\0")) context.addIssue({ code: "custom", message: "path must not contain NUL" });
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
      context.addIssue({ code: "custom", message: "path must be repository-relative" });
    }
    if (path.includes("\\")) context.addIssue({ code: "custom", message: "path must use POSIX separators" });

    const segments = path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({ code: "custom", message: "path must be normalized" });
    }
    if (segments.some((segment) => /^\.env/i.test(segment))) {
      context.addIssue({ code: "custom", message: "path must not name an environment file" });
    }
    if (segments.some((segment) => /\.(pem|key)$/i.test(segment))) {
      context.addIssue({ code: "custom", message: "path must not name a key file" });
    }
    if (segments.some((segment) => /^(credentials|secrets)$/i.test(segment))) {
      context.addIssue({ code: "custom", message: "path must not use a secret directory" });
    }
  });

export const ProjectIdentitySchema = z
  .object({
    component: nonEmptyText.optional(),
    system: nonEmptyText.optional(),
    domain: nonEmptyText.optional(),
    owner: nonEmptyText.optional(),
    branch: nonEmptyText.optional(),
    head: fullGitSha.optional(),
    workingTree: z.enum(["clean", "dirty"]),
    catalogState: z.enum(["resolved", "missing", "invalid"]),
    catalogWarning: nonEmptyText.optional(),
  })
  .strict();

const localMemoryEvidence = z
  .object({
    kind: z.literal("local_memory"),
    path: z.literal(".agents/memory.md"),
    startLine: evidenceLineNumber,
    endLine: evidenceLineNumber,
    contentHash: Sha256Schema,
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, "endLine must not precede startLine");

const codeEvidence = z
  .object({
    kind: z.literal("code"),
    path: RelativePathSchema,
    startLine: evidenceLineNumber,
    endLine: evidenceLineNumber,
    symbol: nonEmptyText.optional(),
    graphState: z.enum(["ready", "pending", "stale"]),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, "endLine must not precede startLine");

const gitEvidence = z
  .object({
    kind: z.literal("git"),
    commit: evidenceGitSha,
    path: RelativePathSchema.optional(),
    startLine: evidenceLineNumber.optional(),
    endLine: evidenceLineNumber.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.startLine === undefined) !== (value.endLine === undefined)) {
      context.addIssue({ code: "custom", message: "git line ranges must include both bounds" });
    }
    if (value.startLine !== undefined && value.endLine !== undefined && value.endLine < value.startLine) {
      context.addIssue({ code: "custom", message: "endLine must not precede startLine" });
    }
  });

const sharedMemoryEvidence = z
  .object({
    kind: z.literal("shared_memory"),
    memoryId: z.uuid(),
    repository: nonEmptyText.optional(),
    path: RelativePathSchema.optional(),
    commitSha: fullGitSha.optional(),
    heading: nonEmptyText.optional(),
  })
  .strict();

export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  localMemoryEvidence,
  codeEvidence,
  gitEvidence,
  sharedMemoryEvidence,
]);

export const ProvenanceSchema = z
  .object({
    sourceType: z.enum(["agent", "human", "git"]),
    actor: nonEmptyText,
    repository: nonEmptyText.optional(),
    path: RelativePathSchema.optional(),
    commitSha: fullGitSha.optional(),
    heading: nonEmptyText.optional(),
    sourceKey: nonEmptyText.optional(),
    capturedAt: Rfc3339TimestampSchema,
  })
  .strict();

export const SharedScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system"), name: safeName }).strict(),
  z.object({ kind: z.literal("domain"), name: safeName }).strict(),
  z.object({ kind: z.literal("org") }).strict(),
]);

export const ProviderFailureSchema = z
  .object({
    provider: z.enum(["local_memory", "code", "git", "shared_memory"]),
    code: z.enum(["timeout", "missing", "invalid_response", "unauthorized", "unavailable", "internal"]),
    elapsedMs: z.number().finite().nonnegative(),
  })
  .strict();

export const PacketMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    generatedAt: Rfc3339TimestampSchema,
    gitHead: fullGitSha.optional(),
    branch: nonEmptyText.optional(),
    estimatedTokens: z.number().int().nonnegative().max(5_000),
  })
  .strict();

export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;
export type RelativePath = z.infer<typeof RelativePathSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type SharedScope = z.infer<typeof SharedScopeSchema>;
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;
export type PacketMetadata = z.infer<typeof PacketMetadataSchema>;
