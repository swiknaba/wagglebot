import { readFile } from "node:fs/promises";
import {
  AuthChallengeRequestSchema,
  type AuthChallengeResponse,
  AuthSessionRequestSchema,
  type AuthSessionResponse,
  type D26Audience,
} from "@wagglebot/contracts";
import { canonicalChallengeBytes } from "@wagglebot/d26-auth";
import { importPKCS8, SignJWT } from "jose";
import type { PublicKeyResolver } from "./catalog-keys";
import type { InMemoryChallengeStore } from "./challenge-store";
import type { SshSignatureVerifier } from "./ssh-verifier";

const SESSION_TTL_SECONDS = 900;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CHALLENGES_PER_WINDOW = 10;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

type SigningKey = Parameters<SignJWT["sign"]>[0];

export class AuthRateLimitError extends Error {
  constructor() {
    super("auth rate limited");
  }
}

export class AuthIssuer {
  private readonly issuer: string;
  private readonly signingKey: SigningKey;
  private readonly challenges: InMemoryChallengeStore;
  private readonly keyResolver: PublicKeyResolver;
  private readonly verifier: SshSignatureVerifier;
  private readonly clock: () => Date;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly rateLimits = new Map<string, { count: number; expiresAtMs: number }>();

  constructor(options: {
    issuer: string;
    signingKey: SigningKey;
    challenges: InMemoryChallengeStore;
    keyResolver: PublicKeyResolver;
    verifier: SshSignatureVerifier;
    clock?: () => Date;
    randomBytes?: (length: number) => Uint8Array;
  }) {
    this.issuer = options.issuer;
    this.signingKey = options.signingKey;
    this.challenges = options.challenges;
    this.keyResolver = options.keyResolver;
    this.verifier = options.verifier;
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  async issueChallenge(input: {
    username: string;
    audience: D26Audience;
    signal: AbortSignal;
  }): Promise<AuthChallengeResponse> {
    const parsed = AuthChallengeRequestSchema.safeParse({
      schemaVersion: 1,
      username: input.username,
      audience: input.audience,
    });
    if (!parsed.success || input.signal.aborted) {
      throw new Error("authentication failed");
    }
    this.consumeRateLimit(parsed.data.username, parsed.data.audience);
    return this.challenges.issue({ username: parsed.data.username, audience: parsed.data.audience });
  }

  async exchangeSignature(input: {
    challengeId: string;
    nonce: string;
    username: string;
    signature: string;
    signal: AbortSignal;
  }): Promise<AuthSessionResponse> {
    try {
      const parsed = AuthSessionRequestSchema.parse({
        schemaVersion: 1,
        challengeId: input.challengeId,
        nonce: input.nonce,
        username: input.username,
        signature: input.signature,
      });
      if (input.signal.aborted) throw new Error("aborted");
      const challenge = await this.challenges.consumeAttempt(parsed);
      const key = await this.keyResolver.resolve(parsed.username, input.signal);
      if (key.username !== parsed.username) throw new Error("invalid key");
      const verified = await this.verifier.verify({
        payload: canonicalChallengeBytes(challenge),
        signature: parsed.signature,
        username: parsed.username,
        authorizedKey: key.authorizedKey,
        signal: input.signal,
      });
      if (!verified) throw new Error("invalid signature");
      await this.challenges.consumeSuccess(challenge.challengeId);

      const issuedAtSeconds = Math.floor(this.clock().getTime() / 1000);
      const expiresAtSeconds = issuedAtSeconds + SESSION_TTL_SECONDS;
      const tokenId = `jti_${Buffer.from(this.randomBytes(21)).toString("base64url")}`;
      const accessToken = await new SignJWT({ sub: parsed.username, aud: challenge.audience, jti: tokenId })
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
        .setIssuer(this.issuer)
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(this.signingKey);
      return {
        schemaVersion: 1,
        accessToken,
        tokenType: "Bearer",
        expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
        principal: { username: parsed.username, keyFingerprint: key.fingerprint },
      };
    } catch {
      throw new Error("authentication failed");
    }
  }

  private consumeRateLimit(username: string, audience: D26Audience): void {
    const now = this.clock().getTime();
    for (const [key, value] of this.rateLimits) {
      if (value.expiresAtMs <= now) this.rateLimits.delete(key);
    }
    const key = `${username}\u0000${audience}`;
    const existing = this.rateLimits.get(key);
    if (existing && existing.expiresAtMs > now) {
      if (existing.count >= MAX_CHALLENGES_PER_WINDOW) throw new AuthRateLimitError();
      existing.count += 1;
      return;
    }
    if (this.rateLimits.size >= MAX_RATE_LIMIT_ENTRIES) throw new AuthRateLimitError();
    this.rateLimits.set(key, { count: 1, expiresAtMs: now + RATE_LIMIT_WINDOW_MS });
  }
}

export async function loadIssuerSigningKey(signingPrivateKeyFile: string): Promise<SigningKey> {
  try {
    return await importPKCS8(await readFile(signingPrivateKeyFile, "utf8"), "EdDSA");
  } catch {
    throw new Error("auth signing key unavailable");
  }
}
