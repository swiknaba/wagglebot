import { describe, expect, test } from "bun:test";
import { InMemoryChallengeStore } from "./challenge-store";

describe("InMemoryChallengeStore", () => {
  test("issues a 60-second challenge that only its echoed nonce can consume", async () => {
    let now = new Date("2026-09-13T12:00:00.000Z");
    const store = new InMemoryChallengeStore({
      clock: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(length),
    });
    const challenge = await store.issue({ username: "alice", audience: "wagglebot-memory" });

    expect(challenge.expiresAt).toBe("2026-09-13T12:01:00.000Z");
    await expect(
      store.consumeAttempt({ challengeId: challenge.challengeId, nonce: "A".repeat(43), username: "alice" }),
    ).rejects.toThrow("invalid challenge");
    await expect(
      store.consumeAttempt({ challengeId: challenge.challengeId, nonce: challenge.nonce, username: "alice" }),
    ).resolves.toMatchObject({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      audience: "wagglebot-memory",
    });
    await store.consumeSuccess(challenge.challengeId);
    await expect(
      store.consumeAttempt({ challengeId: challenge.challengeId, nonce: challenge.nonce, username: "alice" }),
    ).rejects.toThrow("invalid challenge");

    now = new Date("2026-09-13T12:01:00.000Z");
  });

  test("rejects expired challenges and the fourth signature attempt", async () => {
    let now = new Date("2026-09-13T12:00:00.000Z");
    const store = new InMemoryChallengeStore({
      clock: () => now,
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    });
    const challenge = await store.issue({ username: "alice", audience: "wagglebot-memory" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        store.consumeAttempt({ challengeId: challenge.challengeId, nonce: "A".repeat(43), username: "alice" }),
      ).rejects.toThrow("invalid challenge");
    }
    await expect(
      store.consumeAttempt({ challengeId: challenge.challengeId, nonce: challenge.nonce, username: "alice" }),
    ).rejects.toThrow("invalid challenge");

    const expiring = await store.issue({ username: "alice", audience: "wagglebot-memory" });
    now = new Date("2026-09-13T12:01:00.000Z");
    await expect(
      store.consumeAttempt({ challengeId: expiring.challengeId, nonce: expiring.nonce, username: "alice" }),
    ).rejects.toThrow("invalid challenge");
  });

  test("allows at most one successful claim after concurrent verification", async () => {
    const store = new InMemoryChallengeStore();
    const challenge = await store.issue({ username: "alice", audience: "wagglebot-memory" });
    await Promise.all([
      store.consumeAttempt({ challengeId: challenge.challengeId, nonce: challenge.nonce, username: "alice" }),
      store.consumeAttempt({ challengeId: challenge.challengeId, nonce: challenge.nonce, username: "alice" }),
    ]);

    const claims = await Promise.allSettled([
      store.consumeSuccess(challenge.challengeId),
      store.consumeSuccess(challenge.challengeId),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  });
});
