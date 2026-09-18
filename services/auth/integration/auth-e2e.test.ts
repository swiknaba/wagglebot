import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthClient, canonicalChallengeBytes, SshAgentSigner, verifyAuthSessionToken } from "@wagglebot/auth-protocol";
import { generateKeyPair } from "jose";
import { createCatalogPublicKeyResolver } from "../src/catalog-keys";
import { InMemoryChallengeStore } from "../src/challenge-store";
import { createApp } from "../src/http";
import { AuthIssuer } from "../src/issuer";
import { OpenSshSignatureVerifier } from "../src/ssh-verifier";

const directories: string[] = [];
let signatureSequence = 0;

async function run(args: string[]): Promise<void> {
  const process = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  if ((await process.exited) !== 0) throw new Error("OpenSSH is required for authentication end-to-end tests");
}

async function agent(privateKeyPath: string) {
  const socketPath = join(dirname(privateKeyPath), "agent.sock");
  const agentProcess = Bun.spawn(["ssh-agent", "-a", socketPath, "-s"], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(agentProcess.stdout).text();
  if ((await agentProcess.exited) !== 0) throw new Error("ssh-agent is required for authentication end-to-end tests");
  const socket = output.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1];
  const processId = output.match(/SSH_AGENT_PID=(\d+);/)?.[1];
  if (!socket || !processId) throw new Error("ssh-agent did not report a socket");
  const environment = { ...process.env, SSH_AUTH_SOCK: socket, SSH_AGENT_PID: processId };
  const added = Bun.spawn(["ssh-add", privateKeyPath], {
    env: environment,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await added.exited) !== 0) throw new Error("ssh-agent could not add the test key");
  const listed = Bun.spawn(["ssh-add", "-L"], { env: environment, stdout: "pipe", stderr: "ignore" });
  const agentKeys = await new Response(listed.stdout).text();
  if ((await listed.exited) !== 0 || !agentKeys.includes((await readFile(`${privateKeyPath}.pub`, "utf8")).trim())) {
    throw new Error("ssh-agent did not retain the test key");
  }
  return { socket, processId };
}

async function stopAgent(agentSocket: string, processId: string): Promise<void> {
  const agentProcess = Bun.spawn(["ssh-agent", "-k"], {
    env: { ...process.env, SSH_AUTH_SOCK: agentSocket, SSH_AGENT_PID: processId },
    stdout: "ignore",
    stderr: "ignore",
  });
  await agentProcess.exited;
}

async function sign(privateKeyPath: string, payload: Uint8Array, namespace = "wagglebot-auth@wagglebot.dev") {
  const payloadPath = `${privateKeyPath}.challenge-${signatureSequence++}`;
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
    clock: () => now,
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("real SSHSIG exchange binds an authentication token to its audience and expires it", async () => {
  const environment = await fixture();
  const client = new AuthClient({
    baseUrl: "https://auth.example.test",
    username: "alice",
    signer: { sign: (payload) => sign(environment.privateKeyPath, payload) },
    fetch: environment.fetch,
    clock: () => new Date("2026-09-13T12:00:00.000Z"),
  });
  const token = await client.get("wagglebot-memory", new AbortController().signal);
  await expect(
    verifyAuthSessionToken(token.token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory",
      publicKey: environment.issuerPublicKey,
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    }),
  ).resolves.toMatchObject({ username: "alice", audience: "wagglebot-memory" });
  await expect(
    verifyAuthSessionToken(token.token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-registry",
      publicKey: environment.issuerPublicKey,
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    }),
  ).rejects.toThrow("invalid session token");
  environment.advance(16);
  await expect(
    verifyAuthSessionToken(token.token, {
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

test("a catalog key rotation rejects new old-key exchanges without revoking issued tokens", async () => {
  const environment = await fixture();
  const client = new AuthClient({
    baseUrl: "https://auth.example.test",
    username: "alice",
    signer: { sign: (payload) => sign(environment.privateKeyPath, payload) },
    fetch: environment.fetch,
    clock: () => new Date("2026-09-13T12:00:00.000Z"),
  });
  const issued = await client.get("wagglebot-memory", new AbortController().signal);

  const replacementKeyPath = join(dirname(environment.privateKeyPath), "id_replacement");
  await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", replacementKeyPath]);
  const replacementPublicKey = (await readFile(`${replacementKeyPath}.pub`, "utf8")).trim();
  await writeFile(
    environment.catalogPath,
    `apiVersion: backstage.io/v1alpha1\nkind: User\nmetadata:\n  name: alice\n  annotations:\n    wagglebot.dev/ssh-key: ${JSON.stringify(replacementPublicKey)}\n`,
  );
  await environment.resolver.refresh(new AbortController().signal);

  await expect(
    verifyAuthSessionToken(issued.token, {
      issuer: "https://auth.example.test",
      audience: "wagglebot-memory",
      publicKey: environment.issuerPublicKey,
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    }),
  ).resolves.toMatchObject({ username: "alice" });
  const staleKeyClient = new AuthClient({
    baseUrl: "https://auth.example.test",
    username: "alice",
    signer: { sign: (payload) => sign(environment.privateKeyPath, payload) },
    fetch: environment.fetch,
    clock: () => new Date("2026-09-13T12:00:00.000Z"),
  });
  await expect(staleKeyClient.get("wagglebot-registry", new AbortController().signal)).rejects.toThrow(
    "authentication request failed",
  );
});

test("the real client refreshes near expiry once for concurrent callers", async () => {
  const environment = await fixture();
  let signatures = 0;
  const client = new AuthClient({
    baseUrl: "https://auth.example.test",
    username: "alice",
    signer: {
      sign: async (payload) => {
        signatures += 1;
        return sign(environment.privateKeyPath, payload);
      },
    },
    fetch: environment.fetch,
    clock: environment.clock,
  });

  const first = await client.get("wagglebot-memory", new AbortController().signal);
  environment.advance(14);
  const [second, third] = await Promise.all([
    client.get("wagglebot-memory", new AbortController().signal),
    client.get("wagglebot-memory", new AbortController().signal),
  ]);

  expect(second).toEqual(third);
  expect(second.token).not.toBe(first.token);
  expect(signatures).toBe(2);
});

test("an isolated ssh-agent signs an SSHSIG without exposing its private key", async () => {
  const environment = await fixture();
  const originalSocket = process.env.SSH_AUTH_SOCK;
  const originalProcessId = process.env.SSH_AGENT_PID;
  const isolatedAgent = await agent(environment.privateKeyPath);
  process.env.SSH_AUTH_SOCK = isolatedAgent.socket;
  process.env.SSH_AGENT_PID = isolatedAgent.processId;
  try {
    const signer = new SshAgentSigner({ publicKeyPath: `${environment.privateKeyPath}.pub` });
    await expect(
      signer.sign(new TextEncoder().encode("agent proof\n"), new AbortController().signal),
    ).resolves.toContain("BEGIN SSH SIGNATURE");
    const client = new AuthClient({
      baseUrl: "https://auth.example.test",
      username: "alice",
      signer,
      fetch: environment.fetch,
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    await expect(client.get("wagglebot-coordination", new AbortController().signal)).resolves.toMatchObject({
      token: expect.any(String),
    });
  } finally {
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    if (originalProcessId === undefined) delete process.env.SSH_AGENT_PID;
    else process.env.SSH_AGENT_PID = originalProcessId;
    await stopAgent(isolatedAgent.socket, isolatedAgent.processId);
  }
});
