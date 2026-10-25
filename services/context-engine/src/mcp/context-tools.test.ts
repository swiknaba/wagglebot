import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LocalBrain } from "@wagglebot/local-brain";
import { createContextEngine } from "../engine";
import { registerContextTools } from "./context-tools";

const identity = {
  component: "payments",
  system: "billing",
  branch: "main",
  head: "a".repeat(40),
  workingTree: "clean" as const,
  catalogState: "resolved" as const,
};
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

test("registers the four retrieval tools and preserves L0 and single-representation contracts", async () => {
  let memorySearches = 0;
  const brain = {
    identify: async () => identity,
    memory: {
      search: async () => {
        memorySearches += 1;
        return {
          hits: [
            {
              id: "chunk-a",
              path: ".agents/memory/warnings/retries.md",
              type: "Warning",
              title: "Retry safely",
              description: "",
              tags: ["retry"],
              headingPath: ["Warning"],
              content: "Check the operation key before retrying.",
              startLine: 2,
              endLine: 3,
              contentHash: "b".repeat(64),
              score: 1,
            },
          ],
          bundleHash: "c".repeat(64),
        };
      },
    },
    code: {
      status: async () => ({ state: "missing", pendingFiles: [], observedAt: new Date().toISOString() }),
      close: async () => {},
      exploreContext: async () => ({
        query: "retry",
        state: "ready",
        nodes: [],
        edges: [],
        pendingFiles: [],
        observedAt: new Date().toISOString(),
        limitations: [],
      }),
    },
    git: {
      status: async () => ({
        state: "ready",
        head: identity.head,
        branch: "main",
        workingTree: "clean",
        shallow: false,
      }),
      history: async () => ({ commits: [], limitations: [] }),
    },
    status: async () => ({
      project: identity,
      memory: { path: ".agents/memory", state: "ready", observedAt: new Date().toISOString() },
      codeGraph: { state: "missing", pendingFiles: [], observedAt: new Date().toISOString() },
      git: { state: "ready", shallow: false },
      observedAt: new Date().toISOString(),
    }),
    close: async () => {},
  } as unknown as LocalBrain;
  const engine = createContextEngine(brain);
  const server = new McpServer({ name: "context-tools-test", version: "1.0.0" });
  registerContextTools(server, engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-tools-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "brain_explain",
      "brain_search",
      "brain_status",
      "brain_wake",
    ]);
    const wake = await client.callTool({ name: "brain_wake", arguments: { projectPath: "/repo", level: 0 } });
    expect(wake.isError).toBeUndefined();
    expect(textContent(wake)).toContain("No new retrieved context.");
    expect(memorySearches).toBe(0);
    const infeasibleStructuredWake = await client.callTool({
      name: "brain_wake",
      arguments: { projectPath: "/repo", level: 0, responseFormat: "structured" },
    });
    expect(infeasibleStructuredWake.isError).toBe(true);
    expect(textContent(infeasibleStructuredWake)).toBe("context_invalid");

    const search = await client.callTool({
      name: "brain_search",
      arguments: { projectPath: "/repo", query: "how should retries work", responseFormat: "markdown" },
    });
    const prose = "Check the operation key before retrying.";
    expect(textContent(search)).toContain(prose);
    expect(JSON.stringify(search.structuredContent)).not.toContain(prose);
    expect(memorySearches).toBe(1);
  } finally {
    await client.close();
    await server.close();
    await engine.close();
  }
});
