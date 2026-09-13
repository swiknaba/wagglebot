import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalChallengeBytes, D26Client, verifyD26SessionToken } from "@wagglebot/d26-auth";
import { generateKeyPair } from "jose";
import { createCatalogPublicKeyResolver } from "../src/catalog-keys";
import { InMemoryChallengeStore } from "../src/challenge-store";
import { createApp } from "../src/http";
import { AuthIssuer } from "../src/issuer";
import { OpenSshSignatureVerifier } from "../src/ssh-verifier";

const directories: string[] = [];

async function run(args: string[]): Promise<void> {
  const process = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  if ((await process.exited) !== 0) throw new Error("OpenSSH is required for D26 end-to-end tests");
}

async function sign(privateKeyPath: string, payload: Uint8Array, namespace = "wagglebot-auth@wagglebot.dev") {
  const payloadPath = `${privateKeyPath}.challenge`;
  await writeFile(payloadPath, payload, { mode: 0o600 });
  await run(["ssh-keygen", "-Y", "sign", "-f", privateKeyPath, "-n", namespace, payloadPath]);
  return readFile(`${payloadPath}.sig`, "utf8");
}

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".wagglebot-auth-e2e-"));
  directories.push(directory);
  const privateKeyPath = join(directory, "id_ed25519");
  await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath]);
  const publicKey = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
  const catalogPath = join(directory, "catalog.yaml");
  await writeFile(
    catalogPath,
    `apiVersion: backstage.io/v1alpha1\nkind: User\nmetadata:\n  name: alice\n  annotations:\n    wagglebot.dev/ssh-key: ${JSON.stringify(publicKey)}\n`,
  );
  const resolver = createCatalogPublicKeyResolver({ catalogPath });
  await resolver.refresh(new AbortController().signal);
  const { privateKey: issuerPrivateKey, publicKey: issuerPublicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
  });
  let now = new Date("2026-09-13T12:00:00.000Z");
  const issuer = new AuthIssuer({
    issuer: "https://auth.example.test",
    signingKey: issuerPrivateKey,
    challenges: new InMemoryChallengeStore({ clock: () => now }),
    keyResolver: resolver,
    verifier: new OpenSshSignatureVerifier(),
    clock: () => now,
  });
  const app = createApp({
    issuer,
    readiness: () => ({ catalog: resolver.ready() ? "ready" : "unavailable", signingKey: "ready" }),
  });
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init));
  return {
    privateKeyPath,
    catalogPath,
    publicKey,
    resolver,
    issuer,
    issuerPublicKey,
    fetch,
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("real SSHSIG exchange binds a D26 token to its audience and expires it", async () => {
  const environment = await fixture();
  const client = new D26Client({
    baseUrl: "https://auth.example.test",
    username: "alice",
    signer: { sign: (payload) => sign(environment.privateKeyPath, payload) },
    fetch: environment.fetch,
    clock: () => new Date("2026-09-13T12:00:00.000Z"),
  });
  const token = await client.get("wagglebot-memory", new AbortController().signal);
  await expect(
    verifyD26SessionToken(token.token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory",
      publicKey: environment.issuerPublicKey,
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    }),
  ).resolves.toMatchObject({ username: "alice", audience: "wagglebot-memory" });
  await expect(
    verifyD26SessionToken(token.token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-registry",
      publicKey: environment.issuerPublicKey,
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    }),
  ).rejects.toThrow("invalid session token");
  environment.advance(16);
  await expect(
    verifyD26SessionToken(token.token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory",
      publicKey: environment.issuerPublicKey,
      clock: () => new Date("2026-09-13T12:16:00.000Z"),
    }),
  ).rejects.toThrow("invalid session token");
});

test("real SSHSIG verification rejects a replay and mismatched challenge values", async () => {
  const environment = await fixture();
  const challenge = await environment.issuer.issueChallenge({
    username: "alice",
    audience: "wagglebot-memory",
    signal: new AbortController().signal,
  });
  const signature = await sign(environment.privateKeyPath, canonicalChallengeBytes(challenge));
  const request = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    username: "alice",
    signature,
    signal: new AbortController().signal,
  };
  await expect(environment.issuer.exchangeSignature(request)).resolves.toMatchObject({ tokenType: "Bearer" });
  await expect(environment.issuer.exchangeSignature(request)).rejects.toThrow("authentication failed");

  const changedChallenge = await environment.issuer.issueChallenge({
    username: "alice",
    audience: "wagglebot-memory",
    signal: new AbortController().signal,
  });
  const changedSignature = await sign(environment.privateKeyPath, canonicalChallengeBytes(changedChallenge));
  await expect(
    environment.issuer.exchangeSignature({
      ...request,
      challengeId: changedChallenge.challengeId,
      nonce: "A".repeat(43),
      signature: changedSignature,
    }),
  ).rejects.toThrow("authentication failed");
});
