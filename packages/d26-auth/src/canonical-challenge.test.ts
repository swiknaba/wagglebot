import { describe, expect, test } from "bun:test";
import { canonicalChallengeBytes, D26_SIGNATURE_NAMESPACE } from "./canonical-challenge";

const challenge = (audience: "wagglebot-memory" | "wagglebot-registry") => ({
  schemaVersion: 1 as const,
  challengeId: "ch_0123456789abcdef0123456789",
  nonce: "A".repeat(43),
  username: "alice",
  audience,
  signatureNamespace: D26_SIGNATURE_NAMESPACE,
  expiresAt: "2026-09-12T12:01:00.000Z",
});

describe("D26 canonical challenge", () => {
  test("is deterministic and newline-delimited", () => {
    const bytes = canonicalChallengeBytes(challenge("wagglebot-memory"));
    expect(new TextDecoder().decode(bytes)).toBe(
      "wagglebot-auth-v1\nch_0123456789abcdef0123456789\n" +
        "A".repeat(43) +
        "\nalice\nwagglebot-memory\n2026-09-12T12:01:00.000Z\n",
    );
  });

  test("binds the audience to the signed bytes", () => {
    expect(canonicalChallengeBytes(challenge("wagglebot-memory"))).not.toEqual(
      canonicalChallengeBytes(challenge("wagglebot-registry")),
    );
  });

  test("uses a fixed namespace and rejects control characters", () => {
    expect(D26_SIGNATURE_NAMESPACE).toBe("wagglebot-auth@wagglebot.dev");
    expect(() => canonicalChallengeBytes({ ...challenge("wagglebot-memory"), username: "alice\n" })).toThrow();
    expect(() =>
      canonicalChallengeBytes({ ...challenge("wagglebot-memory"), signatureNamespace: "other" as never }),
    ).toThrow();
  });
});
