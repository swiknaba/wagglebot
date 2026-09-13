import { z } from "zod";

const username = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const signatureNamespace = "wagglebot-auth@wagglebot.dev" as const;

export const D26AudienceSchema = z.enum(["wagglebot-registry", "wagglebot-memory", "wagglebot-coordination"]);

export const AuthChallengeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    username,
    audience: D26AudienceSchema,
  })
  .strict();

export const AuthChallengeResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    challengeId: z.string().regex(/^ch_[A-Za-z0-9_-]{28}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    username,
    audience: D26AudienceSchema,
    signatureNamespace: z.literal(signatureNamespace),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AuthSessionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    challengeId: z.string().regex(/^ch_[A-Za-z0-9_-]{28}$/),
    username,
    signature: z.string().min(80).max(16_384),
  })
  .strict();

export const AuthSessionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    accessToken: z.string().min(100),
    tokenType: z.literal("Bearer"),
    expiresAt: z.iso.datetime({ offset: true }),
    principal: z.object({ username: z.string(), keyFingerprint: z.string() }).strict(),
  })
  .strict();

export const D26SessionClaimsSchema = z
  .object({
    iss: z.string().url(),
    sub: username,
    aud: D26AudienceSchema,
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.string().regex(/^jti_[A-Za-z0-9_-]{28}$/),
  })
  .strict()
  .superRefine((claims, ctx) => {
    if (claims.exp <= claims.iat || claims.exp - claims.iat > 900) {
      ctx.addIssue({ code: "custom", message: "session lifetime is invalid" });
    }
  });

export const AuthErrorCodeSchema = z.enum([
  "auth_required",
  "auth_invalid",
  "auth_expired",
  "auth_forbidden",
  "auth_rate_limited",
  "auth_unavailable",
]);

export type D26Audience = z.infer<typeof D26AudienceSchema>;
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequestSchema>;
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponseSchema>;
export type AuthSessionRequest = z.infer<typeof AuthSessionRequestSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type D26SessionClaims = z.infer<typeof D26SessionClaimsSchema>;
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;

export type AuthChallengeRecord = {
  challengeId: string;
  nonceHash: string;
  username: string;
  audience: D26Audience;
  expiresAtMs: number;
  attempts: number;
};

export type D26Principal = {
  username: string;
  audience: D26Audience;
  issuedAt: Date;
  expiresAt: Date;
  tokenId: string;
};

export type D26SessionToken = {
  accessToken: string;
  expiresAt: Date;
  principal: D26Principal;
};
