import type { AuthAudience, AuthPrincipal } from "@wagglebot/contracts";
import { AuthSessionClaimsSchema } from "@wagglebot/contracts";
import { jwtVerify } from "jose";

type VerificationKey = Parameters<typeof jwtVerify>[1];

export type VerifiedAuthPrincipal = AuthPrincipal;

export async function verifyAuthSessionToken(
  token: string,
  options: { issuer: string; audience: AuthAudience; publicKey: VerificationKey; clock?: () => Date },
): Promise<VerifiedAuthPrincipal> {
  try {
    const { payload } = await jwtVerify(token, options.publicKey, {
      algorithms: ["EdDSA"],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: 30,
      ...(options.clock ? { currentDate: options.clock() } : {}),
    });
    const claims = AuthSessionClaimsSchema.parse(payload);
    return {
      username: claims.sub,
      audience: claims.aud,
      issuedAt: new Date(claims.iat * 1000),
      expiresAt: new Date(claims.exp * 1000),
      tokenId: claims.jti,
    };
  } catch {
    throw new Error("invalid session token");
  }
}
