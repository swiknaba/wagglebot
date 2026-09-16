import { expect, test } from "bun:test";
import { loadAuthConfig } from "./config";
import { loadIssuerSigningKey } from "./issuer";

const validEnvironment = {
  AUTH_HOST: "127.0.0.1",
  AUTH_PORT: "8080",
  AUTH_ISSUER: "https://auth.example.test",
  AUTH_SIGNING_PRIVATE_KEY_FILE: "/run/secrets/auth-private-key.pem",
  AUTH_CATALOG_PATH: "/app/catalog.yaml",
  AUTH_CATALOG_REFRESH_SECONDS: "60",
  AUTH_KEY_SOURCE: "catalog",
};

test("loads the auth issuer configuration from deployer-facing names", () => {
  expect(loadAuthConfig(validEnvironment)).toEqual({
    bindHost: "127.0.0.1",
    port: 8080,
    issuer: "https://auth.example.test",
    signingPrivateKeyFile: "/run/secrets/auth-private-key.pem",
    catalogPath: "/app/catalog.yaml",
    catalogRefreshSeconds: 60,
    keySource: "catalog",
    challengeTtlSeconds: 60,
    sessionTtlSeconds: 900,
    clockSkewSeconds: 30,
    maxAttemptsPerChallenge: 3,
    rateLimitWindowSeconds: 60,
    maxChallengesPerWindow: 10,
  });
});

test("rejects missing or invalid required settings", () => {
  for (const name of [
    "AUTH_ISSUER",
    "AUTH_SIGNING_PRIVATE_KEY_FILE",
    "AUTH_CATALOG_PATH",
    "AUTH_CATALOG_REFRESH_SECONDS",
    "AUTH_KEY_SOURCE",
  ]) {
    const environment = { ...validEnvironment };
    delete environment[name as keyof typeof environment];
    expect(() => loadAuthConfig(environment)).toThrow(name);
  }

  expect(() => loadAuthConfig({ ...validEnvironment, AUTH_ISSUER: "http://auth.example.test" })).toThrow("AUTH_ISSUER");
  expect(() => loadAuthConfig({ ...validEnvironment, AUTH_PORT: "0" })).toThrow("AUTH_PORT");
  expect(() => loadAuthConfig({ ...validEnvironment, AUTH_CATALOG_REFRESH_SECONDS: "0" })).toThrow(
    "AUTH_CATALOG_REFRESH_SECONDS",
  );
  expect(() => loadAuthConfig({ ...validEnvironment, AUTH_KEY_SOURCE: "unsupported" })).toThrow("AUTH_KEY_SOURCE");
});

test("requires the pinned GitHub keys host for the GitHub key source", () => {
  expect(() => loadAuthConfig({ ...validEnvironment, AUTH_KEY_SOURCE: "github" })).toThrow("AUTH_GITHUB_KEYS_HOST");
  expect(
    loadAuthConfig({
      ...validEnvironment,
      AUTH_KEY_SOURCE: "github",
      AUTH_GITHUB_KEYS_HOST: "github.example.test",
    }).githubKeysHost,
  ).toBe("github.example.test");
});

test("rejects the removed D26 environment names", () => {
  expect(() =>
    loadAuthConfig({
      ...validEnvironment,
      D26_AUTH_HOST: "127.0.0.1",
    }),
  ).toThrow("D26_AUTH_HOST");
});

test("does not start without a readable Ed25519 signing key", async () => {
  await expect(loadIssuerSigningKey("/path/that/does/not/exist.pem")).rejects.toThrow("auth signing key unavailable");
});
