import type { AuthChallengeResponse } from "@wagglebot/contracts";

export const AUTH_SIGNATURE_NAMESPACE = "wagglebot-auth@wagglebot.dev" as const;

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

export function canonicalChallengeBytes(challenge: AuthChallengeResponse): Uint8Array {
  if (challenge.signatureNamespace !== AUTH_SIGNATURE_NAMESPACE) {
    throw new Error("invalid authentication signature namespace");
  }

  const values = [challenge.challengeId, challenge.nonce, challenge.username, challenge.audience, challenge.expiresAt];
  if (values.some(hasControlCharacter)) {
    throw new Error("invalid authentication challenge value");
  }

  return new TextEncoder().encode(`${["wagglebot-auth-v1", ...values].join("\n")}\n`);
}
