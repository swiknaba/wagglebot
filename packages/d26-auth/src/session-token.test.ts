import { describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";
import { verifyD26SessionToken } from "./session-token";

describe("D26 session token verification", () => {
  test("requires the configured issuer, audience, and EdDSA claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const token = await new SignJWT({ sub: "alice", aud: "wagglebot-memory", jti: "jti_1234567890123456789012345678" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("https://auth.example.test")
      .setIssuedAt(1000)
      .setExpirationTime(1900)
      .sign(privateKey);
    const principal = await verifyD26SessionToken(token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory",
      publicKey,
      clock: () => new Date(1000 * 1000),
    });
    expect(principal.username).toBe("alice");
    expect(principal.tokenId).toMatch(/^jti_/);
    await expect(
      verifyD26SessionToken(token, { issuer: "https://auth.example.test", audience: "wagglebot-registry", publicKey }),
    ).rejects.toThrow("invalid session token");
  });

  test("rejects expired and malformed tokens without exposing the bearer", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const token = await new SignJWT({ sub: "alice", aud: "wagglebot-memory", jti: "jti_1234567890123456789012345678" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("https://auth.example.test")
      .setIssuedAt(0)
      .setExpirationTime(10)
      .sign(privateKey);
    await expect(
      verifyD26SessionToken(token, {
        issuer: "https://auth.example.test",
        audience: "wagglebot-memory",
        publicKey,
        clock: () => new Date(1000 * 1000),
      }),
    ).rejects.toThrow("invalid session token");
    await expect(
      verifyD26SessionToken("not-a-token", {
        issuer: "https://auth.example.test",
        audience: "wagglebot-memory",
        publicKey,
      }),
    ).rejects.toThrow("invalid session token");
  });
});
