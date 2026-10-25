import { parseDocument } from "yaml";
import { z } from "zod";
import { MemoryConfidenceSchema, MemoryKindSchema, SharedScopeSchema } from "../../contracts/src/memory";

const name = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const wireScope = z
  .string()
  .refine((value) => value === "org" || /^(system|domain):[a-z0-9][a-z0-9._-]*$/u.test(value));
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: wireScope,
    owner: name,
    kind: MemoryKindSchema,
    title: z
      .string()
      .min(1)
      .superRefine((value, context) => {
        if ([...value].length > 200)
          context.addIssue({ code: "custom", message: "title must be at most 200 code points" });
      }),
    confidence: MemoryConfidenceSchema,
    wake: z.boolean().default(false),
    reviewAfter: date.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.wake && value.reviewAfter === undefined) {
      context.addIssue({ code: "custom", path: ["reviewAfter"], message: "reviewAfter is required when wake is true" });
    }
  });

export type KnowledgeMetadata = Omit<z.infer<typeof metadataSchema>, "scope"> & {
  scope: z.infer<typeof SharedScopeSchema>;
};
export type KnowledgeDocument = { metadata: KnowledgeMetadata; body: string };

function invalid(message: string): never {
  throw new Error(`invalid reviewed knowledge document: ${message}`);
}

export function parseKnowledgeDocument(source: string): KnowledgeDocument {
  const opening = source.startsWith("---\r\n") ? 5 : source.startsWith("---\n") ? 4 : 0;
  if (!opening) invalid("frontmatter must start with ---");
  const closing = /\r?\n---(?:\r?\n|$)/gu;
  closing.lastIndex = opening;
  const match = closing.exec(source);
  if (!match) invalid("frontmatter closing delimiter is missing");
  const frontmatterEnd = match.index;
  const yaml = source.slice(opening, frontmatterEnd);
  const parsed = parseDocument(yaml, { uniqueKeys: true, strict: true });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
    invalid(parsed.errors[0]?.message ?? parsed.warnings[0]?.message ?? "YAML is invalid");
  }
  const root = parsed.toJS() as unknown;
  if (typeof root !== "object" || root === null || Array.isArray(root)) invalid("expected a wagglebot mapping");
  const rootRecord = root as Record<string, unknown>;
  const extraRoot = Object.keys(rootRecord).filter((key) => key !== "wagglebot");
  if (extraRoot.length > 0) invalid(`unknown frontmatter key ${extraRoot.join(", ")}`);
  const raw = rootRecord.wagglebot;
  const result = metadataSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.map(String).join(".") || "wagglebot";
    invalid(`${field}: ${issue?.message ?? "invalid value"}`);
  }
  const scopeParts = result.data.scope === "org" ? undefined : result.data.scope.split(":");
  const scope =
    result.data.scope === "org"
      ? { kind: "org" as const }
      : scopeParts?.[0] === "system"
        ? { kind: "system" as const, name: scopeParts[1] ?? "" }
        : { kind: "domain" as const, name: scopeParts?.[1] ?? "" };
  const validScope = SharedScopeSchema.safeParse(scope);
  if (!validScope.success) invalid("scope is invalid");
  const bodyStart = match.index + match[0].length;
  return { metadata: { ...result.data, scope: validScope.data }, body: source.slice(bodyStart) };
}
