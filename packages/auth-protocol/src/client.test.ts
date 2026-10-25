import { describe, expect, test } from "bun:test";
import type { AuthChallengeResponse } from "@wagglebot/contracts";
import { AuthClient } from "./client";

const challenge: AuthChallengeResponse = {
  schemaVersion: 1,
  challengeId: "ch_1234567890123456789012345678",
  nonce: "1234567890123456789012345678901234567890123",
  username: "alice",
  audience: "wagglebot-memory",
  signatureNamespace: "wagglebot-auth@wagglebot.dev",
  expiresAt: "2026-09-13T12:00:00.000Z",
};

describe("authentication client", () => {
  test("exchanges one challenge and caches by audience", async () => {
    const requests: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const body =
        requests.length === 1
          ? challenge
          : {
              schemaVersion: 1,
              accessToken: "x".repeat(100),
              tokenType: "Bearer",
              expiresAt: "2026-09-13T12:00:00.000Z",
              principal: { username: "alice", keyFingerprint: "SHA256:abc" },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const signer = { sign: async () => "x".repeat(80) };
    const client = new AuthClient({
      baseUrl: "http://127.0.0.1:8787",
      username: "alice",
      signer,
      fetch: fetcher,
      clock: () => new Date("2026-09-13T11:58:00.000Z"),
    });
    const first = await client.get("wagglebot-memory", new AbortController().signal);
    const second = await client.get("wagglebot-memory", new AbortController().signal);
    expect(first).toEqual(second);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[1]?.headers.has("authorization")).toBe(false);
    expect(await requests[1]?.json()).toMatchObject({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      username: "alice",
    });
  });

  test("retries exactly once after a 401", async () => {
    let calls = 0;
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      calls += 1;
      if (calls === 2) return new Response(null, { status: 401 });
      if (new URL(input.toString()).pathname.endsWith("/challenge")) {
        return new Response(JSON.stringify(challenge), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          accessToken: "x".repeat(100),
          tokenType: "Bearer",
          expiresAt: "2026-09-13T12:00:00.000Z",
          principal: { username: "alice", keyFingerprint: "SHA256:abc" },
        }),
        { status: 200 },
      );
    };
    const client = new AuthClient({
      baseUrl: "http://127.0.0.1:8787",
      username: "alice",
      signer: { sign: async () => "x".repeat(80) },
      fetch: fetcher,
    });
    await expect(client.get("wagglebot-memory", new AbortController().signal)).resolves.toMatchObject({
      token: "x".repeat(100),
    });
    expect(calls).toBe(4);
  });
});
