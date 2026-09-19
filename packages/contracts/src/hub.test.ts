import { expect, test } from "bun:test";
import { CodeModeExecuteInputSchema, DiscoveryStateSchema, HubConfigSchema } from "./hub";

test("hub config requires a registry source", () => {
  expect(
    HubConfigSchema.safeParse({
      host: "127.0.0.1",
      port: 9000,
      bearerToken: "x".repeat(32),
      configPath: "/config/registry.yaml",
      trustPath: "/tmp/trust",
      codeModeEnabled: true,
    }).success,
  ).toBe(true);
  expect(
    HubConfigSchema.safeParse({ host: "127.0.0.1", port: 9000, bearerToken: "x".repeat(32), trustPath: "/tmp/trust" })
      .success,
  ).toBe(false);
});
test("CodeMode rejects traversal and discovery state models the scheduler lifecycle", () => {
  expect(CodeModeExecuteInputSchema.safeParse({ tool: "../../secrets", arguments: {} }).success).toBe(false);
  expect(
    DiscoveryStateSchema.safeParse({
      status: "unknown",
      toolCount: 0,
      tools: [],
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastDiscoveryError: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
    }).success,
  ).toBe(true);
});
