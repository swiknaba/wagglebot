import { expect, test } from "bun:test";
import { loadRegistry, mergeRegistries } from "./registry";

test("loads and validates a registry", () => {
  const text = `proxies:\n  - namespace: example\n    mode: remote_http\n    endpoint: https://mcp.example.com/mcp\n    auth:\n      scheme: { kind: bearer }\n      source: { from: env, var: EXAMPLE_TOKEN }\n`;
  const proxies = loadRegistry(text, "registry.base.yaml");
  expect(proxies).toHaveLength(1);
  expect(proxies[0]?.namespace).toBe("example");
});

test("rejects an unpinned stdio_npx package", () => {
  const text = `proxies:\n  - namespace: gh\n    mode: stdio_npx\n    command: "@example/mcp@latest"\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/r\.yaml.*gh/);
});

test("rejects a literal credential source", () => {
  const text = `proxies:\n  - namespace: x\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth:\n      scheme: { kind: bearer }\n      source: { from: literal, value: hunter2 }\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/literal/);
});

test("rejects auth missing a source with a clean validation error", () => {
  const text = `proxies:\n  - namespace: y\n    mode: remote_http\n    endpoint: https://y/mcp\n    auth:\n      scheme: { kind: bearer }\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/r\.yaml.*y/);
});

test("rejects a literal env value on a registry proxy", () => {
  const text = `proxies:\n  - namespace: x\n    mode: stdio_cmd\n    command: my-mcp\n    env:\n      API_KEY: hunter2\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/r\.yaml.*x.*literal/s);
});

test("accepts a \\${VAR} env expansion on a registry proxy", () => {
  const text = `proxies:\n  - namespace: x\n    mode: stdio_cmd\n    command: my-mcp\n    env:\n      API_KEY: \${OK_VAR}\n`;
  const proxies = loadRegistry(text, "r.yaml");
  expect(proxies[0]?.env).toEqual({ API_KEY: "${OK_VAR}" });
});

test("rejects an unknown auth.scheme.kind", () => {
  const text = `proxies:\n  - namespace: x\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth:\n      scheme: { kind: made_up }\n      source: { from: env, var: X }\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/scheme\.kind/);
});

test("rejects an unknown auth.source.from", () => {
  const text = `proxies:\n  - namespace: x\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth:\n      scheme: { kind: bearer }\n      source: { from: made_up }\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/source\.from/);
});

test("rejects an empty-object auth source", () => {
  const text = `proxies:\n  - namespace: x\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth:\n      scheme: { kind: bearer }\n      source: {}\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/source\.from/);
});

test("rejects an array auth scheme", () => {
  const text = `proxies:\n  - namespace: x\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth:\n      scheme: []\n      source: { from: env, var: X }\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/auth requires both/);
});

test("team layer wins per namespace, shallow merge", () => {
  const base = loadRegistry(
    `proxies:\n  - { namespace: a, mode: remote_http, endpoint: https://a/mcp }\n  - { namespace: b, mode: remote_http, endpoint: https://b/mcp }\n`,
    "base",
  );
  const team = loadRegistry(
    `proxies:\n  - { namespace: b, mode: remote_http, endpoint: https://b2/mcp }\n  - { namespace: c, mode: remote_http, endpoint: https://c/mcp }\n`,
    "team",
  );
  const merged = mergeRegistries(base, team);
  expect(merged.map((p) => `${p.namespace}:${p.endpoint}`)).toEqual([
    "a:https://a/mcp",
    "b:https://b2/mcp",
    "c:https://c/mcp",
  ]);
});
