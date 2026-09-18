import { describe, expect, test } from "bun:test";
import { SshAgentSigner } from "./ssh-signer";

describe("SshAgentSigner", () => {
  test("requires an ssh-agent before spawning ssh-keygen", async () => {
    const original = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      await expect(
        new SshAgentSigner({ publicKeyPath: "/tmp/id_ed25519.pub" }).sign(
          new Uint8Array([1]),
          new AbortController().signal,
        ),
      ).rejects.toThrow("ssh-agent is unavailable");
    } finally {
      if (original === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = original;
    }
  });

  test("rejects an unavailable public key", async () => {
    const original = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    try {
      await expect(
        new SshAgentSigner({ publicKeyPath: "/tmp/does-not-exist.pub" }).sign(
          new Uint8Array([1]),
          new AbortController().signal,
        ),
      ).rejects.toThrow("public key is unavailable");
    } finally {
      if (original === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = original;
    }
  });
});
