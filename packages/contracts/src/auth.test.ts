import { describe, expect, test } from "bun:test";
import {
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthErrorCodeSchema,
  AuthSessionRequestSchema,
  AuthSessionResponseSchema,
  D26SessionClaimsSchema,
} from "./auth";

const validChallengeId = "ch_1234567890123456789012345678";
const validJti = "jti_1234567890123456789012345678";

describe("D26 authentication contracts", () => {
  test("accepts valid challenge requests and rejects unknown keys", () => {
    expect(
      AuthChallengeRequestSchema.parse({
        schemaVersion: 1,
        username: "alice",
        audience: "wagglebot-memory",
      }),
    ).toEqual({ schemaVersion: 1, username: "alice", audience: "wagglebot-memory" });

    expect(() =>
      AuthChallengeRequestSchema.parse({
        schemaVersion: 1,
        username: "alice",
        audience: "wagglebot-memory",
        scope: "admin",
      }),
    ).toThrow();
  });

  test("rejects invalid usernames, audiences, and control characters", () => {
    for (const username of ["Alice", "", "alice\u0000", "alice\n"]) {
      expect(() =>
        AuthChallengeRequestSchema.parse({ schemaVersion: 1, username, audience: "wagglebot-memory" }),
      ).toThrow();
    }
    expect(() =>
      AuthChallengeRequestSchema.parse({ schemaVersion: 1, username: "alice", audience: "admin" }),
    ).toThrow();
    expect(() =>
      AuthChallengeRequestSchema.parse({ schemaVersion: 2, username: "alice", audience: "wagglebot-memory" }),
    ).toThrow();
  });

  test("validates challenge and session wire formats", () => {
    const expiresAt = "2026-09-13T12:00:00.000Z";
    expect(
      AuthChallengeResponseSchema.parse({
        schemaVersion: 1,
        challengeId: validChallengeId,
        nonce: "1234567890123456789012345678901234567890123",
        username: "alice",
        audience: "wagglebot-memory",
        signatureNamespace: "wagglebot-auth@wagglebot.dev",
        expiresAt,
      }).expiresAt,
    ).toBe(expiresAt);
    expect(() =>
      AuthChallengeResponseSchema.parse({
        schemaVersion: 1,
        challengeId: "bad",
        nonce: "bad",
        username: "alice",
        audience: "wagglebot-memory",
        signatureNamespace: "wagglebot-auth@wagglebot.dev",
        expiresAt,
      }),
    ).toThrow();

    expect(() =>
      AuthSessionRequestSchema.parse({
        schemaVersion: 1,
        challengeId: validChallengeId,
        username: "alice",
        signature: "short",
      }),
    ).toThrow();
    expect(() =>
      AuthSessionRequestSchema.parse({
        schemaVersion: 1,
        challengeId: validChallengeId,
        username: "alice",
        signature: "x".repeat(80),
        extra: true,
      }),
    ).toThrow();
    expect(
      AuthSessionResponseSchema.parse({
        schemaVersion: 1,
        accessToken: "x".repeat(100),
        tokenType: "Bearer",
        expiresAt,
        principal: { username: "alice", keyFingerprint: "SHA256:abc" },
      }).tokenType,
    ).toBe("Bearer");
  });

  test("enforces exact session claim lifetime and shape", () => {
    const claims = {
      iss: "https://auth.example.test",
      sub: "alice",
      aud: "wagglebot-memory" as const,
      iat: 1000,
      exp: 1900,
      jti: validJti,
    };
    expect(D26SessionClaimsSchema.parse(claims)).toEqual(claims);
    expect(() => D26SessionClaimsSchema.parse({ ...claims, exp: 1000 })).toThrow();
    expect(() => D26SessionClaimsSchema.parse({ ...claims, exp: 1901 })).toThrow();
    expect(() => D26SessionClaimsSchema.parse({ ...claims, alg: "HS256" })).toThrow();
  });

  test("enumerates stable authentication error codes", () => {
    const codes = [
      "auth_required",
      "auth_invalid",
      "auth_expired",
      "auth_forbidden",
      "auth_rate_limited",
      "auth_unavailable",
    ] as const;
    for (const code of codes) {
      expect(AuthErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(() => AuthErrorCodeSchema.parse("internal_error")).toThrow();
  });
});
