import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMcpHubApprove } from "./mcp-hub-approve";

test("approves a validated registry namespace without printing secrets", async () => {
  const dir = mkdtempSync(join("/tmp", "waggle-approve-"));
  const configPath = join(dir, "registry.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      revision: `reg_${"a".repeat(64)}`,
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-09-13T00:00:00.000Z",
      principal: { username: "alice" },
      proxies: [{ namespace: "x", mode: "remote_http", endpoint: "https://x.example/mcp" }],
      toolCatalog: { version: 1, title: "T", platform_context: [], operating_principles: [], families: [] },
    }),
  );
  const lines: string[] = [];
  expect(
    await runMcpHubApprove({
      namespace: "x",
      configPath,
      trustPath: join(dir, "trust.json"),
      confirm: async () => "approve",
      write: (line) => lines.push(line),
    }),
  ).toBe(0);
  expect(lines.join("\n")).not.toContain("secret");
});
