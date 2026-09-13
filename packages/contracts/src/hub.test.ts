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
test("CodeMode rejects traversal and discovery state is bounded", () => {
  expect(CodeModeExecuteInputSchema.safeParse({ tool: "../../secrets", arguments: {} }).success).toBe(false);
  expect(
    DiscoveryStateSchema.safeParse({
      status: "ready",
      toolCount: 2,
      tools: [],
      lastAttemptAt: null,
      lastSuccessAt: "2026-09-12T12:00:00.000Z",
      consecutiveFailures: 0,
      nextRetryAt: null,
    }).success,
  ).toBe(true);
});
