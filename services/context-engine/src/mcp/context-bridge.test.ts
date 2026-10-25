import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LocalBrain } from "@wagglebot/local-brain";
import { ContextVault, createContextBridge } from "@wagglebot/local-brain";
import { registerContextBridgeTools } from "./context-bridge";

const identity = { workingTree: "clean" as const, catalogState: "resolved" as const };
const textContent = (result: unknown): string => {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content))
    return "";
  return result.content
    .filter(
      (item): item is { type: string; text?: string } => typeof item === "object" && item !== null && "type" in item,
    )
    .filter((item) => item.type === "text")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
};

test("registers four explicit bridge tools and keeps each response to one prose representation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-bridge-mcp-"));
  const repo = join(parent, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  const brain = { identify: async () => identity } as unknown as Pick<LocalBrain, "identify">;
  const bridge = createContextBridge(brain, { vault: new ContextVault({ directory: join(parent, "vault") }) });
  await bridge.initialize();
  const server = new McpServer({ name: "context-bridge-test", version: "1.0.0" });
  registerContextBridgeTools(server, bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-bridge-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "brain_context_export",
      "brain_context_import",
      "brain_context_revoke",
      "brain_context_status",
    ]);
    const exported = await client.callTool({
      name: "brain_context_export",
      arguments: {
        projectPath: repo,
        goal: "Preserve the reviewed API decision",
        decisions: [{ title: "Keep v1 stable", summary: "Use additive fields only." }],
        openQuestions: [],
        evidence: [],
        providerState: { localBrain: "ready", sharedMemory: "not_requested" },
        responseFormat: "structured",
      },
    });
    const packetResult = exported.structuredContent as { handle: string; packet: { goal: string } };
    expect(packetResult.packet.goal).toBe("Preserve the reviewed API decision");
    expect(JSON.stringify(exported.content)).not.toContain(packetResult.packet.goal);

    const imported = await client.callTool({
      name: "brain_context_import",
      arguments: { handle: packetResult.handle, projectPath: repo, responseFormat: "markdown" },
    });
    expect(textContent(imported)).toContain("Preserve the reviewed API decision");
    expect(JSON.stringify(imported.structuredContent)).not.toContain("Preserve the reviewed API decision");

    const revoked = await client.callTool({
      name: "brain_context_revoke",
      arguments: { handle: packetResult.handle, projectPath: repo },
    });
    expect(revoked.structuredContent).toMatchObject({ schemaVersion: 1, revoked: true });
  } finally {
    await client.close();
    await server.close();
    await rm(parent, { recursive: true, force: true });
  }
});
