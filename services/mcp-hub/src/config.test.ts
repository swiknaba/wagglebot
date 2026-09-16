import { expect, test } from "bun:test";
import { loadHubConfig } from "./config";

test("loads defaults and requires a secure registry source", () => {
  const config = loadHubConfig({ MCP_HUB_BEARER_TOKEN: "x".repeat(32), MCP_HUB_CONFIG_PATH: "/config/registry.yaml" });
  expect(config.port).toBe(9000);
  expect(config.codeModeEnabled).toBe(true);
  expect(() => loadHubConfig({ MCP_HUB_BEARER_TOKEN: "short", MCP_HUB_CONFIG_URL: "http://insecure" })).toThrow();
});
