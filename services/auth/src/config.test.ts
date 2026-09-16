import { expect, test } from "bun:test";
import { loadAuthConfig } from "./config";
import { loadIssuerSigningKey } from "./issuer";

const validEnvironment = {
  D26_AUTH_HOST: "127.0.0.1",
  D26_AUTH_PORT: "8080",
  D26_AUTH_ISSUER: "https://auth.example.test",
  D26_AUTH_SIGNING_PRIVATE_KEY_FILE: "/run/secrets/d26-private-key.pem",
  D26_AUTH_CATALOG_PATH: "/app/catalog.yaml",
  D26_AUTH_CATALOG_REFRESH_SECONDS: "60",
  D26_AUTH_KEY_SOURCE: "catalog",
};

test("loads the strict D26 issuer configuration", () => {
  expect(loadAuthConfig(validEnvironment)).toEqual({
    bindHost: "127.0.0.1",
    port: 8080,
    issuer: "https://auth.example.test",
    signingPrivateKeyFile: "/run/secrets/d26-private-key.pem",
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
    "D26_AUTH_ISSUER",
    "D26_AUTH_SIGNING_PRIVATE_KEY_FILE",
    "D26_AUTH_CATALOG_PATH",
    "D26_AUTH_CATALOG_REFRESH_SECONDS",
    "D26_AUTH_KEY_SOURCE",
  ]) {
    const environment = { ...validEnvironment };
    delete environment[name as keyof typeof environment];
    expect(() => loadAuthConfig(environment)).toThrow(name);
  }

  expect(() => loadAuthConfig({ ...validEnvironment, D26_AUTH_ISSUER: "http://auth.example.test" })).toThrow(
    "D26_AUTH_ISSUER",
  );
  expect(() => loadAuthConfig({ ...validEnvironment, D26_AUTH_PORT: "0" })).toThrow("D26_AUTH_PORT");
  expect(() => loadAuthConfig({ ...validEnvironment, D26_AUTH_CATALOG_REFRESH_SECONDS: "0" })).toThrow(
    "D26_AUTH_CATALOG_REFRESH_SECONDS",
  );
  expect(() => loadAuthConfig({ ...validEnvironment, D26_AUTH_KEY_SOURCE: "unsupported" })).toThrow(
    "D26_AUTH_KEY_SOURCE",
  );
});

test("requires the pinned GitHub keys host for the GitHub key source", () => {
  expect(() => loadAuthConfig({ ...validEnvironment, D26_AUTH_KEY_SOURCE: "github" })).toThrow(
    "D26_AUTH_GITHUB_KEYS_HOST",
  );
  expect(
    loadAuthConfig({
      ...validEnvironment,
      D26_AUTH_KEY_SOURCE: "github",
      D26_AUTH_GITHUB_KEYS_HOST: "github.example.test",
    }).githubKeysHost,
  ).toBe("github.example.test");
});

test("does not start without a readable Ed25519 signing key", async () => {
  await expect(loadIssuerSigningKey("/path/that/does/not/exist.pem")).rejects.toThrow("auth signing key unavailable");
});
