import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogPublicKeyResolver, createGitHubPublicKeyResolver } from "./catalog-keys";

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA comment";
const directories: string[] = [];

async function catalogFile(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wagglebot-auth-catalog-"));
  directories.push(directory);
  const path = join(directory, "catalog.yaml");
  await Bun.write(path, text);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test("catalog resolver returns a normalized key and SHA-256 fingerprint", async () => {
  const path = await catalogFile(`
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations:
    wagglebot.dev/ssh-key: "${VALID_KEY}"
spec: { memberOf: [] }
`);
  const resolver = createCatalogPublicKeyResolver({ catalogPath: path });

  await resolver.refresh(new AbortController().signal);
  const key = await resolver.resolve("alice", new AbortController().signal);

  expect(key).toEqual({
    username: "alice",
    authorizedKey: VALID_KEY.split(" ").slice(0, 2).join(" "),
    fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
    source: "catalog",
  });
  expect(resolver.ready()).toBe(true);
});

test("catalog resolver rejects duplicate users and malformed keys before publishing a refresh", async () => {
  const path = await catalogFile(`
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations: { wagglebot.dev/ssh-key: "${VALID_KEY}" }
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations: { wagglebot.dev/ssh-key: "ssh-rsa not-a-key" }
`);
  const resolver = createCatalogPublicKeyResolver({ catalogPath: path });

  await expect(resolver.refresh(new AbortController().signal)).rejects.toThrow("catalog key refresh failed");
  expect(resolver.ready()).toBe(false);
  await expect(resolver.resolve("alice", new AbortController().signal)).rejects.toThrow("authentication failed");
});

test("a failed later refresh retains the last known valid catalog key", async () => {
  const path = await catalogFile(`
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations: { wagglebot.dev/ssh-key: "${VALID_KEY}" }
`);
  const resolver = createCatalogPublicKeyResolver({ catalogPath: path });
  await resolver.refresh(new AbortController().signal);
  const original = await resolver.resolve("alice", new AbortController().signal);
  await Bun.write(path, "kind: User\nmetadata: { name: alice }\n");

  await expect(resolver.refresh(new AbortController().signal)).rejects.toThrow("catalog key refresh failed");
  await expect(resolver.resolve("alice", new AbortController().signal)).resolves.toEqual(original);
  expect(resolver.ready()).toBe(false);
});

test("GitHub resolver fetches only the pinned HTTPS user-key URL and refreshes after fifteen minutes", async () => {
  let now = new Date("2026-09-13T12:00:00.000Z");
  const requested: string[] = [];
  const resolver = createGitHubPublicKeyResolver({
    githubKeysHost: "keys.example.test",
    clock: () => now,
    fetch: async (input) => {
      requested.push(String(input));
      return new Response(`${VALID_KEY}\n`, { status: 200 });
    },
  });

  const first = await resolver.resolve("alice", new AbortController().signal);
  const cached = await resolver.resolve("alice", new AbortController().signal);
  now = new Date("2026-09-13T12:15:00.001Z");
  const refreshed = await resolver.resolve("alice", new AbortController().signal);

  expect(first.source).toBe("github");
  expect(cached).toEqual(first);
  expect(refreshed).toEqual(first);
  expect(requested).toEqual(["https://keys.example.test/alice.keys", "https://keys.example.test/alice.keys"]);
  expect(resolver.ready()).toBe(true);
});

test("GitHub resolver rejects redirects and keeps no untrusted key", async () => {
  const resolver = createGitHubPublicKeyResolver({
    githubKeysHost: "keys.example.test",
    fetch: async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://attacker.example/alice.keys" },
      }),
  });

  await expect(resolver.resolve("alice", new AbortController().signal)).rejects.toThrow("authentication failed");
  expect(resolver.ready()).toBe(false);
});
