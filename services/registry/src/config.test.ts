import { expect, test } from "bun:test";
import { loadRegistryConfig } from "./config";

const valid = {
  REGISTRY_HOST: "127.0.0.1",
  REGISTRY_PORT: "3040",
  REGISTRY_ISSUER: "https://auth.example.test",
  REGISTRY_COMPANY_ROOT: "/config/company-repository",
  REGISTRY_SOURCE_REVISION: "0123456789abcdef0123456789abcdef01234567",
  REGISTRY_REFRESH_SECONDS: "900",
  REGISTRY_MAX_RESPONSE_BYTES: "262144",
};

test("loads strict registry configuration", () => {
  expect(loadRegistryConfig(valid)).toEqual({
    bindHost: "127.0.0.1",
    port: 3040,
    issuer: "https://auth.example.test",
    companyRoot: "/config/company-repository",
    sourceRevision: valid.REGISTRY_SOURCE_REVISION,
    refreshSeconds: 900,
    maxResponseBytes: 262144,
  });
});

test("rejects missing, malformed, and unknown configuration", () => {
  expect(() => loadRegistryConfig({ ...valid, REGISTRY_ISSUER: "http://auth.example.test" })).toThrow(
    /REGISTRY_ISSUER/,
  );
  expect(() => loadRegistryConfig({ ...valid, REGISTRY_PORT: "0" })).toThrow(/REGISTRY_PORT/);
  expect(() => loadRegistryConfig({ ...valid, EXTRA: "x" })).toThrow(/EXTRA/);
  expect(() => loadRegistryConfig({ ...valid, REGISTRY_REFRESH_SECONDS: "0" })).toThrow(/REGISTRY_REFRESH_SECONDS/);
});
