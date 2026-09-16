import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenSshSignatureVerifier } from "./ssh-verifier";

const directories: string[] = [];

async function command(args: string[]): Promise<void> {
  const process = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  if ((await process.exited) !== 0) throw new Error("OpenSSH test setup failed");
}

async function signedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "wagglebot-auth-verify-"));
  directories.push(directory);
  const privateKeyPath = join(directory, "id_ed25519");
  const payloadPath = join(directory, "payload");
  const payload = new TextEncoder().encode("wagglebot-auth-v1\nchallenge\n");
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath]);
  await writeFile(payloadPath, payload, { mode: 0o600 });
  await command(["ssh-keygen", "-Y", "sign", "-f", privateKeyPath, "-n", "wagglebot-auth@wagglebot.dev", payloadPath]);
  return {
    payload,
    signature: await readFile(`${payloadPath}.sig`, "utf8"),
    authorizedKey: (await readFile(`${privateKeyPath}.pub`, "utf8")).trim(),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("verifies a canonical SSHSIG and rejects a tampered payload", async () => {
  const fixture = await signedFixture();
  const verifier = new OpenSshSignatureVerifier();

  await expect(verifier.verify({ ...fixture, username: "alice", signal: new AbortController().signal })).resolves.toBe(
    true,
  );
  await expect(
    verifier.verify({
      ...fixture,
      payload: new TextEncoder().encode("wagglebot-auth-v1\ntampered\n"),
      username: "alice",
      signal: new AbortController().signal,
    }),
  ).resolves.toBe(false);
});

test("maps malformed signatures and unavailable OpenSSH to a generic verification failure", async () => {
  const verifier = new OpenSshSignatureVerifier({ sshKeygenPath: "not-a-real-ssh-keygen" });

  await expect(
    verifier.verify({
      payload: new Uint8Array([1]),
      signature: "not-a-signature",
      username: "alice",
      authorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      signal: new AbortController().signal,
    }),
  ).resolves.toBe(false);
});
