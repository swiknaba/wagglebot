import { timingSafeEqual } from "node:crypto";
import { AUTH_SIGNATURE_NAMESPACE } from "@wagglebot/auth-protocol";
import type { AuthAudience, AuthChallengeResponse } from "@wagglebot/contracts";

type StoredChallenge = {
  challengeId: string;
  nonceHash: string;
  username: string;
  audience: AuthAudience;
  expiresAtMs: number;
  attempts: number;
};

type RandomBytes = (length: number) => Uint8Array;

const CHALLENGE_TTL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const CLEANUP_LIMIT = 1_000;

export class InMemoryChallengeStore {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly clock: () => Date;
  private readonly randomBytes: RandomBytes;
  private queue = Promise.resolve();

  constructor(options: { clock?: () => Date; randomBytes?: RandomBytes } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  async issue(input: { username: string; audience: AuthAudience }): Promise<AuthChallengeResponse> {
    const nonce = base64Url(this.randomBytes(32));
    const challengeId = `ch_${base64Url(this.randomBytes(21))}`;
    const expiresAtMs = this.clock().getTime() + CHALLENGE_TTL_MS;
    const nonceHash = await hashNonce(nonce);
    await this.withLock(() => {
      this.cleanupExpired();
      this.challenges.set(challengeId, { ...input, challengeId, nonceHash, expiresAtMs, attempts: 0 });
    });
    return {
      schemaVersion: 1,
      challengeId,
      nonce,
      username: input.username,
      audience: input.audience,
      signatureNamespace: AUTH_SIGNATURE_NAMESPACE,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async consumeAttempt(input: {
    challengeId: string;
    nonce: string;
    username: string;
  }): Promise<AuthChallengeResponse> {
    const nonceHash = await hashNonce(input.nonce);
    return this.withLock(() => {
      this.cleanupExpired();
      const challenge = this.challenges.get(input.challengeId);
      if (!challenge || challenge.username !== input.username || challenge.attempts >= MAX_ATTEMPTS) {
        throw new Error("invalid challenge");
      }
      challenge.attempts += 1;
      if (!sameHash(challenge.nonceHash, nonceHash)) throw new Error("invalid challenge");
      return {
        schemaVersion: 1,
        challengeId: challenge.challengeId,
        nonce: input.nonce,
        username: challenge.username,
        audience: challenge.audience,
        signatureNamespace: AUTH_SIGNATURE_NAMESPACE,
        expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      };
    });
  }

  async consumeSuccess(challengeId: string): Promise<void> {
    await this.withLock(() => {
      this.cleanupExpired();
      if (!this.challenges.delete(challengeId)) throw new Error("invalid challenge");
    });
  }

  private async withLock<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: (() => void) | undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  private cleanupExpired() {
    const now = this.clock().getTime();
    let removed = 0;
    for (const [challengeId, challenge] of this.challenges) {
      if (removed >= CLEANUP_LIMIT) return;
      if (challenge.expiresAtMs <= now) {
        this.challenges.delete(challengeId);
        removed += 1;
      }
    }
  }
}

async function hashNonce(nonce: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return Buffer.from(hash).toString("base64url");
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sameHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
