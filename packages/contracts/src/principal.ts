import { z } from "zod";
import { Rfc3339TimestampSchema } from "./base";

const username = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const PrincipalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user"),
      username,
      groups: z.array(username),
      orgOwner: z.boolean(),
      issuedAt: Rfc3339TimestampSchema,
      expiresAt: Rfc3339TimestampSchema,
      tokenId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("administrator"), username }).strict(),
]);

export type Principal = z.infer<typeof PrincipalSchema>;
