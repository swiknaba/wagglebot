import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BrainExplainInputSchema,
  BrainSearchInputSchema,
  BrainStatusInputSchema,
  BrainWakeInputSchema,
} from "@wagglebot/contracts";
import { renderContext } from "../context/representation";
import { type ContextEngine, ContextEngineError } from "../engine";

export const CONTEXT_TOOL_NAMES = ["brain_wake", "brain_search", "brain_explain", "brain_status"] as const;

const errorResult = (error: unknown) => {
  const code = error instanceof ContextEngineError ? error.code : "context_unavailable";
  return { isError: true, content: [{ type: "text" as const, text: code }] };
};

export const registerContextTools = (server: McpServer, engine: ContextEngine): void => {
  server.registerTool("brain_wake", { inputSchema: BrainWakeInputSchema.shape }, async (raw, extra) => {
    const parsed = BrainWakeInputSchema.safeParse(raw);
    if (!parsed.success) return errorResult(new ContextEngineError("context_invalid", "context_invalid"));
    try {
      const packet = await engine.wake(parsed.data, extra.signal);
      const rendered = renderContext(packet, parsed.data.responseFormat ?? "markdown");
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        structuredContent: rendered.structuredContent,
      };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("brain_search", { inputSchema: BrainSearchInputSchema.shape }, async (raw, extra) => {
    const parsed = BrainSearchInputSchema.safeParse(raw);
    if (!parsed.success) return errorResult(new ContextEngineError("context_invalid", "context_invalid"));
    try {
      const packet = await engine.search(parsed.data, extra.signal);
      const rendered = renderContext(packet, parsed.data.responseFormat ?? "markdown");
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        structuredContent: rendered.structuredContent,
      };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("brain_explain", { inputSchema: BrainExplainInputSchema.shape }, async (raw, extra) => {
    const parsed = BrainExplainInputSchema.safeParse(raw);
    if (!parsed.success) return errorResult(new ContextEngineError("context_invalid", "context_invalid"));
    try {
      const packet = await engine.explain(parsed.data, extra.signal);
      const rendered = renderContext(packet, parsed.data.responseFormat ?? "markdown");
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        structuredContent: rendered.structuredContent,
      };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("brain_status", { inputSchema: BrainStatusInputSchema.shape }, async (raw, extra) => {
    const parsed = BrainStatusInputSchema.safeParse(raw);
    if (!parsed.success) return errorResult(new ContextEngineError("context_invalid", "context_invalid"));
    try {
      const result = await engine.status(parsed.data, extra.signal);
      return {
        content: [
          {
            type: "text" as const,
            text: `Context providers: ${Object.entries(result.providers)
              .map(([name, provider]) => `${name}=${provider.state}`)
              .join(", ")}`,
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return errorResult(error);
    }
  });
};
