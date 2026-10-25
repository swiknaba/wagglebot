import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHubConfig } from "./config";
import { createHubRuntime } from "./index";
import { TrustStore } from "./trust";

function tempDir() {
  return mkdtempSync(join("/tmp", "waggle-hub-runtime-"));
}

function registry(proxies: unknown[] = []) {
  return JSON.stringify({
    schemaVersion: 1,
    revision: `reg_${"a".repeat(64)}`,
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-09-13T00:00:00.000Z",
    principal: { username: "alice" },
    proxies,
    toolCatalog: { version: 1, title: "T", platform_context: [], operating_principles: [], families: [] },
  });
}

function config(extra: Record<string, string> = {}) {
  return loadHubConfig({
    MCP_HUB_BEARER_TOKEN: "h".repeat(32),
    MCP_HUB_CONFIG_PATH: "/unused",
    MCP_HUB_TRUST_PATH: "/tmp/trust-unused",
    ...extra,
  });
}

test("missing stdio executables fail startup even when discovery warmup is disabled", async () => {
  const directory = tempDir();
  const registryPath = join(directory, "registry.json");
  const proxy = { namespace: "demo", mode: "stdio_cmd", command: join(directory, "missing") };
  writeFileSync(registryPath, registry([proxy]));
  chmodSync(registryPath, 0o600);
  const trustPath = join(directory, "trust.json");
  const trust = new TrustStore(trustPath);
  await trust.approve(proxy as never, []);
  const hubConfig = config({
    MCP_HUB_CONFIG_PATH: registryPath,
    MCP_HUB_TRUST_PATH: trustPath,
    MCP_HUB_WARMUP_TOOLS: "0",
  });

  await expect(createHubRuntime(hubConfig)).rejects.toThrow("stdio executable not found");
});

test("remote registry outage degrades by default and fails in strict startup mode", async () => {
  const directory = tempDir();
  const base = {
    MCP_HUB_CONFIG_PATH: undefined,
    MCP_HUB_CONFIG_URL: "https://registry.example/registry",
    MCP_HUB_TRUST_PATH: join(directory, "trust.json"),
  };
  const options = {
    fetch: async () => new Response(null, { status: 503 }),
    tokens: { get: async () => ({ token: "registry-session", expiresAt: "" }), invalidate: () => undefined },
  };
  const degraded = await createHubRuntime(config(base as never), options);
  expect(degraded.app.fetch(new Request("http://hub/readyz")).then((response) => response.status)).resolves.toBe(503);
  await degraded.close();

  await expect(createHubRuntime(config({ ...base, MCP_HUB_STARTUP_STRICT: "1" } as never), options)).rejects.toThrow(
    "remote registry unavailable during strict startup",
  );
});
