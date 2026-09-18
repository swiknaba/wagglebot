import {
  type AuthAudience,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthSessionRequestSchema,
  AuthSessionResponseSchema,
} from "@wagglebot/contracts";
import { canonicalChallengeBytes } from "./canonical-challenge";
import type { SshSigner } from "./types";

export interface SessionTokenProvider {
  get(audience: AuthAudience, signal: AbortSignal): Promise<{ token: string; expiresAt: string }>;
  invalidate(audience: AuthAudience): void;
}

type CacheEntry = { token: string; expiresAt: string; expiresAtMs: number };

class AuthHttpError extends Error {
  constructor(readonly status: number) {
    super("authentication request failed");
  }
}

export class AuthClient implements SessionTokenProvider {
  private readonly baseUrl: URL;
  private readonly username: string;
  private readonly signer: SshSigner;
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly clock: () => Date;
  private readonly cache = new Map<AuthAudience, CacheEntry>();
  private readonly inFlight = new Map<AuthAudience, Promise<{ token: string; expiresAt: string }>>();

  constructor(options: {
    baseUrl: string;
    username: string;
    signer: SshSigner;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    clock?: () => Date;
  }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("authentication requires HTTPS");
    }
    this.baseUrl = url;
    this.username = options.username;
    this.signer = options.signer;
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  get(audience: AuthAudience, signal: AbortSignal) {
    const cached = this.cache.get(audience);
    if (cached && cached.expiresAtMs - this.clock().getTime() > 60_000) {
      return Promise.resolve({ token: cached.token, expiresAt: cached.expiresAt });
    }
    const existing = this.inFlight.get(audience);
    if (existing) return existing;
    const request = this.exchangeWithRetry(audience, signal).finally(() => this.inFlight.delete(audience));
    this.inFlight.set(audience, request);
    return request;
  }

  invalidate(audience: AuthAudience) {
    this.cache.delete(audience);
  }

  private async exchangeWithRetry(audience: AuthAudience, signal: AbortSignal) {
    try {
      return await this.exchange(audience, signal);
    } catch (error) {
      if (!(error instanceof AuthHttpError) || error.status !== 401) throw error;
      this.invalidate(audience);
      return this.exchange(audience, signal);
    }
  }

  private async exchange(audience: AuthAudience, signal: AbortSignal) {
    const challengeRequest = AuthChallengeRequestSchema.parse({ schemaVersion: 1, username: this.username, audience });
    const challenge = AuthChallengeResponseSchema.parse(
      await this.post("/v1/auth/challenge", challengeRequest, signal),
    );
    const signature = await this.signer.sign(canonicalChallengeBytes(challenge), signal);
    const sessionRequest = AuthSessionRequestSchema.parse({
      schemaVersion: 1,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      username: this.username,
      signature,
    });
    const response = AuthSessionResponseSchema.parse(await this.post("/v1/auth/session", sessionRequest, signal));
    const token = { token: response.accessToken, expiresAt: response.expiresAt };
    this.cache.set(audience, { ...token, expiresAtMs: Date.parse(response.expiresAt) });
    return token;
  }

  private async post(path: string, body: unknown, signal: AbortSignal) {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new Error("authentication request failed");
    }
    if (!response.ok) throw new AuthHttpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new Error("authentication response was invalid");
    }
  }
}
