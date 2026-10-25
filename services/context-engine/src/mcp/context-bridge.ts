import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ContextBridgeExportInputSchema,
  ContextBridgeHandleInputSchema,
  ContextBridgeRevokeInputSchema,
  ContextBridgeStatusInputSchema,
} from "@wagglebot/contracts";
import type { ContextBridge } from "@wagglebot/local-brain";
import { ContextBridgeError } from "@wagglebot/local-brain";

export const CONTEXT_BRIDGE_TOOL_NAMES = [
  "brain_context_export",
  "brain_context_import",
  "brain_context_status",
  "brain_context_revoke",
] as const;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const encode = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fail = (error: unknown) => text(error instanceof ContextBridgeError ? error.code : "context_unavailable");

const preview = (packet: {
  goal: string;
  decisions: Array<{ title: string; summary: string }>;
  openQuestions: string[];
  evidence: Array<{
    kind: string;
    path?: string;
    startLine?: number;
    endLine?: number;
    commit?: string;
    memoryId?: string;
  }>;
}): string => {
  const lines = [`## Imported context\n\nGoal: ${packet.goal}`];
  if (packet.decisions.length)
    lines.push(
      `\n### Decisions\n${packet.decisions.map(({ title, summary }) => `- **${title}**: ${summary}`).join("\n")}`,
    );
  if (packet.openQuestions.length)
    lines.push(`\n### Open questions\n${packet.openQuestions.map((question) => `- ${question}`).join("\n")}`);
  if (packet.evidence.length)
    lines.push(
      `\n### Evidence\n${packet.evidence.map((item) => `- ${item.kind}: ${item.path ?? item.commit ?? item.memoryId ?? "reference"}${item.startLine ? `:${item.startLine}-${item.endLine}` : ""}`).join("\n")}`,
    );
  return lines.join("\n");
};

export const registerContextBridgeTools = (server: McpServer, bridge: ContextBridge): void => {
  server.registerTool("brain_context_export", { inputSchema: ContextBridgeExportInputSchema.shape }, async (raw) => {
    const parsed = ContextBridgeExportInputSchema.safeParse(raw);
    if (!parsed.success) return text("context_invalid");
    try {
      const result = await bridge.export(parsed.data);
      const format = parsed.data.responseFormat ?? "structured";
      const structuredContent =
        format === "structured" ? result : { schemaVersion: 1, handle: result.handle, packetMeta: result.packetMeta };
      const response =
        format === "structured"
          ? {
              content: [
                {
                  type: "text" as const,
                  text: `Context exported: ${result.packetMeta.packetId}; expires ${result.packetMeta.expiresAt}.`,
                },
              ],
              structuredContent,
            }
          : {
              content: [
                { type: "text" as const, text: `${preview(result.packet)}\n\nExpires: ${result.packetMeta.expiresAt}` },
              ],
              structuredContent,
            };
      if (encode(response) > 16 * 1024) {
        await bridge.revoke({ handle: result.handle, projectPath: parsed.data.projectPath });
        return text("context_limit");
      }
      return response;
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool("brain_context_import", { inputSchema: ContextBridgeHandleInputSchema.shape }, async (raw) => {
    const parsed = ContextBridgeHandleInputSchema.safeParse(raw);
    if (!parsed.success) return text("context_invalid");
    try {
      const result = await bridge.import(parsed.data);
      const format = parsed.data.responseFormat ?? "structured";
      const structuredContent = format === "structured" ? result : { schemaVersion: 1, packetMeta: result.packetMeta };
      const response =
        format === "structured"
          ? {
              content: [{ type: "text" as const, text: `Imported context: ${result.packetMeta.packetId}.` }],
              structuredContent,
            }
          : { content: [{ type: "text" as const, text: preview(result.importedContext) }], structuredContent };
      if (encode(response) > 16 * 1024) return text("context_limit");
      return response;
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool("brain_context_status", { inputSchema: ContextBridgeStatusInputSchema.shape }, async (raw) => {
    const parsed = ContextBridgeStatusInputSchema.safeParse(raw);
    if (!parsed.success) return text("context_invalid");
    try {
      const result = await bridge.status(parsed.data);
      return {
        content: [{ type: "text" as const, text: `Context packets available: ${result.packetCount}.` }],
        structuredContent: result,
      };
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool("brain_context_revoke", { inputSchema: ContextBridgeRevokeInputSchema.shape }, async (raw) => {
    const parsed = ContextBridgeRevokeInputSchema.safeParse(raw);
    if (!parsed.success) return text("context_invalid");
    try {
      return {
        content: [{ type: "text" as const, text: "Context packet revoked." }],
        structuredContent: await bridge.revoke(parsed.data),
      };
    } catch (error) {
      return fail(error);
    }
  });
};
