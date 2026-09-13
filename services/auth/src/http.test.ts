import { expect, test } from "bun:test";
import { AuthChallengeResponseSchema, AuthSessionResponseSchema } from "@wagglebot/contracts";
import { createApp } from "./http";
import { AuthRateLimitError } from "./issuer";

const challenge = {
  schemaVersion: 1 as const,
  challengeId: `ch_${"A".repeat(28)}`,
  nonce: "B".repeat(43),
  username: "alice",
  audience: "wagglebot-memory" as const,
  signatureNamespace: "wagglebot-auth@wagglebot.dev" as const,
  expiresAt: "2026-09-13T12:01:00.000Z",
};
const session = {
  schemaVersion: 1 as const,
  accessToken: "a".repeat(100),
  tokenType: "Bearer" as const,
  expiresAt: "2026-09-13T12:15:00.000Z",
  principal: { username: "alice", keyFingerprint: "SHA256:test" },
};

function createTestApp(options: { ready?: boolean; issueError?: Error; exchangeError?: Error } = {}) {
  const calls: unknown[] = [];
  const app = createApp({
    issuer: {
      async issueChallenge(input) {
        calls.push(input);
        if (options.issueError) throw options.issueError;
        return challenge;
      },
      async exchangeSignature(input) {
        calls.push(input);
        if (options.exchangeError) throw options.exchangeError;
        return session;
      },
    },
    readiness: () => ({ catalog: options.ready === false ? "unavailable" : "ready", signingKey: "ready" }),
    randomBytes: (length) => new Uint8Array(length).fill(length),
  });
  return { app, calls };
}

function request(path: string, body?: unknown) {
  return new Request(`https://auth.example.test${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("serves strict challenge and session contracts without caching", async () => {
  const { app, calls } = createTestApp();
  const challengeResponse = await app.fetch(
    request("/v1/auth/challenge", { schemaVersion: 1, username: "alice", audience: "wagglebot-memory" }),
  );
  expect(challengeResponse.status).toBe(200);
  expect(challengeResponse.headers.get("cache-control")).toBe("no-store");
  expect(AuthChallengeResponseSchema.parse(await challengeResponse.json())).toEqual(challenge);

  const sessionResponse = await app.fetch(
    request("/v1/auth/session", {
      schemaVersion: 1,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      username: "alice",
      signature: "s".repeat(80),
    }),
  );
  expect(sessionResponse.status).toBe(200);
  expect(sessionResponse.headers.get("cache-control")).toBe("no-store");
  expect(AuthSessionResponseSchema.parse(await sessionResponse.json())).toEqual(session);
  expect(calls).toHaveLength(2);
});

test("returns only safe envelopes for invalid and rate-limited requests", async () => {
  const { app } = createTestApp();
  const invalid = await app.fetch(
    request("/v1/auth/challenge", { schemaVersion: 1, username: "alice", audience: "admin" }),
  );
  expect(invalid.status).toBe(400);
  const invalidBody = await invalid.json();
  expect(invalidBody).toMatchObject({
    schemaVersion: 1,
    error: {
      code: "auth_invalid",
      message: "authentication request is invalid",
      retryable: false,
    },
  });
  expect(invalidBody.error.correlationId).toMatch(/^corr_[A-Za-z0-9_-]{22}$/);

  const rateLimited = await createTestApp({ issueError: new AuthRateLimitError() }).app.fetch(
    request("/v1/auth/challenge", { schemaVersion: 1, username: "alice", audience: "wagglebot-memory" }),
  );
  expect(rateLimited.status).toBe(429);
  expect((await rateLimited.json()).error.code).toBe("auth_rate_limited");

  const invalidSession = await app.fetch(request("/v1/auth/session", { schemaVersion: 1, signature: "short" }));
  expect(invalidSession.status).toBe(401);
  expect((await invalidSession.json()).error.code).toBe("auth_invalid");
});

test("bounds request bodies and uses versioned liveness and readiness responses", async () => {
  const { app } = createTestApp();
  const oversized = new Request("https://auth.example.test/v1/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ padding: "a".repeat(32 * 1024) }),
  });
  expect((await app.fetch(oversized)).status).toBe(400);

  expect(await (await app.fetch(new Request("https://auth.example.test/livez"))).json()).toEqual({
    schemaVersion: 1,
    status: "live",
  });
  expect(await (await app.fetch(new Request("https://auth.example.test/readyz"))).json()).toEqual({
    schemaVersion: 1,
    status: "ready",
    dependencies: { catalog: "ready", signingKey: "ready" },
  });

  const unavailable = await createTestApp({ ready: false }).app.fetch(new Request("https://auth.example.test/readyz"));
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).status).toBe("degraded");
  const unavailableChallenge = await createTestApp({ ready: false }).app.fetch(
    request("/v1/auth/challenge", { schemaVersion: 1, username: "alice", audience: "wagglebot-memory" }),
  );
  expect(unavailableChallenge.status).toBe(503);
  expect((await unavailableChallenge.json()).error.code).toBe("auth_unavailable");
});

test("does not expose auth routes through unsupported methods or paths", async () => {
  const { app } = createTestApp();
  expect((await app.fetch(new Request("https://auth.example.test/v1/auth/challenge"))).status).toBe(404);
  expect((await app.fetch(new Request("https://auth.example.test/unlisted"))).status).toBe(404);
});
