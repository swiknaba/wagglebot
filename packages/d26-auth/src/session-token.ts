import type { D26Audience, D26Principal } from "@wagglebot/contracts";
import { D26SessionClaimsSchema } from "@wagglebot/contracts";
import { jwtVerify } from "jose";

type VerificationKey = Parameters<typeof jwtVerify>[1];

export type VerifiedD26Principal = D26Principal;

export async function verifyD26SessionToken(
  token: string,
  options: { issuer: string; audience: D26Audience; publicKey: VerificationKey; clock?: () => Date },
): Promise<VerifiedD26Principal> {
  try {
    const { payload } = await jwtVerify(token, options.publicKey, {
      algorithms: ["EdDSA"],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: 30,
      ...(options.clock ? { currentDate: options.clock() } : {}),
    });
    const claims = D26SessionClaimsSchema.parse(payload);
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
