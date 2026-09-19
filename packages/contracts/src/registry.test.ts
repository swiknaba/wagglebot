import { expect, test } from "bun:test";
import { CredentialSourceSchema, ProxyConfigSchema, RegistrySnapshotSchema } from "./registry";

const validProxy = {
  namespace: "example",
  mode: "remote_http" as const,
  endpoint: "https://mcp.example.com/mcp",
  auth: {
    scheme: { kind: "bearer" as const },
    source: { from: "env" as const, var: "EXAMPLE_TOKEN" },
  },
};

test("accepts a secret-free pinned remote proxy", () => {
  expect(ProxyConfigSchema.safeParse(validProxy).success).toBe(true);
});

test.each([
  { mode: "stdio_npx", command: "example-mcp@latest" },
  { mode: "stdio_npx", command: "example-mcp@^1.2.0" },
  { mode: "remote_http", endpoint: "http://mcp.example.com/mcp" },
])("rejects unsafe registry proxy %o", (override) => {
  expect(ProxyConfigSchema.safeParse({ namespace: "example", ...override }).success).toBe(false);
});

test("rejects literal credentials and unknown fields", () => {
  expect(CredentialSourceSchema.safeParse({ from: "literal", value: "secret" }).success).toBe(false);
  expect(ProxyConfigSchema.safeParse({ ...validProxy, unexpected: true }).success).toBe(false);
});

test("requires a username for basic upstream authentication", () => {
  expect(
    ProxyConfigSchema.safeParse({
      namespace: "example",
      mode: "remote_http",
      endpoint: "https://mcp.example.com/mcp",
      auth: { scheme: { kind: "basic" }, source: { from: "env", var: "EXAMPLE_TOKEN" } },
    }).success,
  ).toBe(false);
});

test("registry snapshots contain revision and no resolved credential value", () => {
  const snapshot = {
    schemaVersion: 1 as const,
    revision: `reg_${"a".repeat(64)}`,
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    generatedAt: "2026-09-13T12:00:00.000Z",
    principal: { username: "alice" },
    proxies: [validProxy],
    toolCatalog: { version: 1 as const, title: "Company", families: [] },
  };
  expect(RegistrySnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(RegistrySnapshotSchema.safeParse({ ...snapshot, token: "secret" }).success).toBe(false);
});
