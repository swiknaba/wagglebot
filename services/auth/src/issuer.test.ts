import { expect, test } from "bun:test";
import { canonicalChallengeBytes, verifyAuthSessionToken } from "@wagglebot/auth-protocol";
import type { AuthAudience } from "@wagglebot/contracts";
import { generateKeyPair, generateSecret, jwtVerify, SignJWT } from "jose";
import type { ResolvedPublicKey } from "./catalog-keys";
import { InMemoryChallengeStore } from "./challenge-store";
import { AuthIssuer, AuthRateLimitError } from "./issuer";

const now = new Date("2026-09-13T12:00:00.000Z");
const resolvedKey: ResolvedPublicKey = {
  username: "alice",
  authorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  fingerprint: "SHA256:test",
  source: "catalog",
};

async function fixture(options: { validSignature?: boolean } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  let currentKey = resolvedKey;
  const verifierCalls: Array<{ payload: Uint8Array; authorizedKey: string }> = [];
  const issuer = new AuthIssuer({
    issuer: "https://auth.example.test",
    signingKey: privateKey,
    challenges: new InMemoryChallengeStore({
      clock: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(length),
    }),
    keyResolver: {
      async resolve() {
        return currentKey;
      },
      async refresh() {},
      ready() {
        return true;
      },
    },
    verifier: {
      async verify(input) {
        verifierCalls.push({ payload: input.payload, authorizedKey: input.authorizedKey });
        return options.validSignature ?? true;
      },
    },
    clock: () => now,
    randomBytes: (length) => new Uint8Array(length).fill(length),
  });
  return {
    issuer,
    publicKey,
    verifierCalls,
    replaceKey(key: ResolvedPublicKey) {
      currentKey = key;
    },
  };
}

async function createChallenge(issuer: AuthIssuer, audience: AuthAudience = "wagglebot-memory") {
  return issuer.issueChallenge({ username: "alice", audience, signal: new AbortController().signal });
}

test("rejects an unknown audience before creating challenge state", async () => {
  const { issuer } = await fixture();
  await expect(
    issuer.issueChallenge({
      username: "alice",
      audience: "unknown" as AuthAudience,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("authentication failed");
});

test("limits challenge creation per username and audience", async () => {
  const { issuer } = await fixture();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await createChallenge(issuer);
  }
  await expect(createChallenge(issuer)).rejects.toBeInstanceOf(AuthRateLimitError);
  await expect(createChallenge(issuer, "wagglebot-registry")).resolves.toMatchObject({
    audience: "wagglebot-registry",
  });
});

test("issues a 15-minute audience-bound EdDSA session token after SSH verification", async () => {
  const { issuer, publicKey, verifierCalls } = await fixture();
  const challenge = await createChallenge(issuer);
  const result = await issuer.exchangeSignature({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    username: "alice",
    signature: "s".repeat(80),
    signal: new AbortController().signal,
  });

  const verified = await jwtVerify(result.accessToken, publicKey, {
    algorithms: ["EdDSA"],
    issuer: "https://auth.example.test",
    audience: "wagglebot-memory",
    currentDate: now,
  });
  expect(verified.protectedHeader).toMatchObject({ alg: "EdDSA", typ: "JWT" });
  expect(verified.payload).toMatchObject({
    sub: "alice",
    aud: "wagglebot-memory",
    iss: "https://auth.example.test",
    iat: 1_789_300_800,
    exp: 1_789_301_700,
  });
  expect(verified.payload.jti).toMatch(/^jti_[A-Za-z0-9_-]{28}$/);
  expect(result.expiresAt).toBe("2026-09-13T12:15:00.000Z");
  expect(result.principal).toEqual({ username: "alice", keyFingerprint: "SHA256:test" });
  expect(verifierCalls).toEqual([
    { payload: canonicalChallengeBytes(challenge), authorizedKey: resolvedKey.authorizedKey },
  ]);
  for (const options of [
    { issuer: "https://other.example.test", audience: "wagglebot-memory" as const, clock: () => now },
    { issuer: "https://auth.example.test", audience: "wagglebot-registry" as const, clock: () => now },
    {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory" as const,
      clock: () => new Date("2026-09-13T12:16:00.000Z"),
    },
  ]) {
    await expect(verifyAuthSessionToken(result.accessToken, { ...options, publicKey })).rejects.toThrow(
      "invalid session token",
    );
  }

  const hmacKey = await generateSecret("HS256");
  const wrongAlgorithm = await new SignJWT({
    sub: "alice",
    aud: "wagglebot-memory",
    jti: "jti_1234567890123456789012345678",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://auth.example.test")
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 900)
    .sign(hmacKey);
  await expect(
    verifyAuthSessionToken(wrongAlgorithm, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory",
      publicKey,
      clock: () => now,
    }),
  ).rejects.toThrow("invalid session token");
});

test("consumes a verified challenge once and returns the same generic error for invalid verification", async () => {
  const { issuer } = await fixture({ validSignature: false });
  const challenge = await createChallenge(issuer);
  const request = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    username: "alice",
    signature: "s".repeat(80),
    signal: new AbortController().signal,
  };
  await expect(issuer.exchangeSignature(request)).rejects.toThrow("authentication failed");

  const valid = await fixture();
  const replayableChallenge = await createChallenge(valid.issuer);
  const successfulRequest = {
    ...request,
    challengeId: replayableChallenge.challengeId,
    nonce: replayableChallenge.nonce,
  };
  await valid.issuer.exchangeSignature(successfulRequest);
  await expect(valid.issuer.exchangeSignature(successfulRequest)).rejects.toThrow("authentication failed");
});

test("uses the replacement catalog key for a later challenge", async () => {
  const { issuer, verifierCalls, replaceKey } = await fixture();
  const first = await createChallenge(issuer);
  await issuer.exchangeSignature({
    challengeId: first.challengeId,
    nonce: first.nonce,
    username: "alice",
    signature: "s".repeat(80),
    signal: new AbortController().signal,
  });
  const replacement = { ...resolvedKey, authorizedKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ==" };
  replaceKey(replacement);
  const second = await createChallenge(issuer);
  await issuer.exchangeSignature({
    challengeId: second.challengeId,
    nonce: second.nonce,
    username: "alice",
    signature: "s".repeat(80),
    signal: new AbortController().signal,
  });
  expect(verifierCalls.map((call) => call.authorizedKey)).toEqual([
    resolvedKey.authorizedKey,
    replacement.authorizedKey,
  ]);
});
