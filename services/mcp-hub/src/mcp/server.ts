import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CodeModeExecuteInputSchema, type HubErrorCode, HubErrorCodeSchema } from "@wagglebot/contracts";
import { z } from "zod";
import type { CodeMode } from "../codemode/tools";
import type { Introspection } from "../introspection";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const boundedText = z.string().refine((value) => [...value].length >= 1 && [...value].length <= 500);
const toolSchemas = {
  search: z
    .object({
      query: boundedText,
      namespace: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  get_schema: z.object({ tool: z.string().min(1).max(120) }).strict(),
  execute: CodeModeExecuteInputSchema,
  list_available_mcps: z.object({}).strict(),
  get_tool_catalog: z.object({}).strict(),
  recommend_tool_families: z.object({ task: boundedText }).strict(),
  get_usage_guide: z.object({}).strict(),
};

type HubAppOptions = {
  bearerToken: string;
  codeMode: CodeMode;
  introspection: Introspection;
  ready: () => boolean;
  codeModeEnabled?: boolean;
  maxBodyBytes?: number;
};

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorPayload(code: HubErrorCode, retryable = false) {
  return {
    schemaVersion: 1,
    error: {
      code,
      message: code === "hub_response_too_large" ? "hub response is too large" : "MCP hub request failed",
      correlationId: `corr_${randomUUID().replaceAll("-", "")}`,
      retryable,
    },
  };
}

function httpError(code: HubErrorCode, status: number, retryable = false): Response {
  return Response.json(errorPayload(code, retryable), { status });
}

function codeFor(error: unknown): HubErrorCode {
  if (error instanceof Error && HubErrorCodeSchema.safeParse(error.message).success)
    return error.message as HubErrorCode;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return "hub_upstream_timeout";
  return "hub_internal";
}

function toolError(error: unknown) {
  const code = codeFor(error);
  return {
    isError: true,
    content: [],
    structuredContent: errorPayload(code, code === "hub_upstream_timeout"),
  };
}

async function readLimited(request: Request, maximum: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("hub request aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException("hub request aborted", "AbortError");
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new RangeError("body too large");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("hub request aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DOMException("hub request aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function withBoundedBody(request: Request, body: Uint8Array | null): Request {
  if (body === null) return request;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    signal: request.signal,
  });
}

function redactJsonRpcError(response: Response, body: Uint8Array): Uint8Array {
  if (!response.headers.get("content-type")?.includes("application/json")) return body;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      error?: { code?: unknown; message?: string };
      result?: { isError?: boolean; structuredContent?: unknown; content?: unknown[] };
    };
    if (typeof parsed.error === "object" && parsed.error !== null) {
      parsed.error = {
        code: typeof parsed.error.code === "number" ? parsed.error.code : -32603,
        message: "hub_invalid_request",
      };
      return new TextEncoder().encode(JSON.stringify(parsed));
    }
    if (parsed.result?.isError && parsed.result.structuredContent === undefined) {
      parsed.result = { isError: true, content: [], structuredContent: errorPayload("hub_invalid_request") };
      return new TextEncoder().encode(JSON.stringify(parsed));
    }
    if (!parsed.result) return body;
    return new TextEncoder().encode(JSON.stringify(parsed));
  } catch {
    return body;
  }
}

export function createHubApp(options: HubAppOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;
  const active = new Set<{ abort: () => void; cleanup: () => Promise<void> }>();
  let closed = false;

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/livez")
        return Response.json({ schemaVersion: 1, status: "live" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        const ready = options.ready();
        return Response.json(
          {
            schemaVersion: 1,
            status: ready ? "ready" : "degraded",
            dependencies: { registry: ready ? "ready" : "unavailable" },
          },
          { status: ready ? 200 : 503 },
        );
      }
      if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
      if (closed) return httpError("hub_internal", 503, true);

      const authorization = request.headers.get("authorization");
      if (authorization === null || !authorization.startsWith("Bearer ") || authorization.length <= 7)
        return httpError("hub_auth_required", 401);
      if (!constantTimeEqual(authorization.slice(7), options.bearerToken)) return httpError("hub_auth_invalid", 401);

      const lifecycle = new AbortController();
      let ended = false;
      let mcp: McpServer | undefined;
      let activeEntry: { abort: () => void; cleanup: () => Promise<void> };
      const cleanup = async () => {
        if (ended) return;
        ended = true;
        await mcp?.close();
        active.delete(activeEntry);
      };
      activeEntry = { abort: () => lifecycle.abort(), cleanup };
      active.add(activeEntry);
      try {
        const requestLifecycleSignal = AbortSignal.any([request.signal, lifecycle.signal]);
        const contentLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > maxBodyBytes)
          return httpError("hub_response_too_large", 413);
        const boundedRequest = withBoundedBody(
          request,
          await untilAborted(readLimited(request, maxBodyBytes, requestLifecycleSignal), requestLifecycleSignal),
        );

        const mcpServer = new McpServer(
          { name: "wagglebot-mcp-hub", version: "0.0.0" },
          { capabilities: { tools: {} } },
        );
        mcp = mcpServer;
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        const register = <T extends z.ZodObject<z.ZodRawShape>>(
          name: string,
          schema: T,
          handler: (args: z.infer<T>, signal: AbortSignal) => unknown | Promise<unknown>,
        ) => {
          const callback = async (args: unknown, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
            try {
              const signal = AbortSignal.any([extra.signal, lifecycle.signal, boundedRequest.signal]);
              const data = await handler(args as z.infer<T>, signal);
              return { content: [], structuredContent: data as Record<string, unknown> };
            } catch (error) {
              return toolError(error);
            }
          };
          mcpServer.registerTool(name, { inputSchema: schema }, callback as ToolCallback<T>);
        };
        if (options.codeModeEnabled ?? true) {
          register("search", toolSchemas.search, ({ query, namespace, limit }) =>
            options.codeMode.search(query, namespace, limit),
          );
          register("get_schema", toolSchemas.get_schema, ({ tool }) => options.codeMode.getSchema(tool));
          register("execute", toolSchemas.execute, ({ tool, arguments: args }, signal) =>
            options.codeMode.execute(tool, args, signal),
          );
        }
        register("list_available_mcps", toolSchemas.list_available_mcps, () =>
          options.introspection.listAvailableMcps(),
        );
        register("get_tool_catalog", toolSchemas.get_tool_catalog, () => options.introspection.getToolCatalog());
        register("recommend_tool_families", toolSchemas.recommend_tool_families, ({ task }) =>
          options.introspection.recommendToolFamilies(task),
        );
        register("get_usage_guide", toolSchemas.get_usage_guide, () => options.introspection.getUsageGuide());
        await mcpServer.connect(transport);
        const requestSignal = AbortSignal.any([boundedRequest.signal, lifecycle.signal]);
        const response = await untilAborted(
          transport.handleRequest(new Request(boundedRequest, { signal: requestSignal })),
          requestSignal,
        );
        let responseBody: Uint8Array | null;
        try {
          responseBody = await untilAborted(
            readLimited(
              new Request("http://hub/response", { method: "POST", body: response.body }),
              maxBodyBytes,
              requestSignal,
            ),
            requestSignal,
          );
        } catch (error) {
          if (error instanceof RangeError) return httpError("hub_response_too_large", 413);
          throw error;
        }
        if (responseBody === null) return new Response(null, { status: response.status, headers: response.headers });
        const safeBody = redactJsonRpcError(response, responseBody);
        return new Response(
          safeBody.buffer.slice(safeBody.byteOffset, safeBody.byteOffset + safeBody.byteLength) as ArrayBuffer,
          { status: response.status, statusText: response.statusText, headers: response.headers },
        );
      } catch (error) {
        if (lifecycle.signal.aborted || request.signal.aborted) return httpError("hub_internal", 503, true);
        if (error instanceof RangeError) return httpError("hub_response_too_large", 413);
        return httpError("hub_internal", 500, true);
      } finally {
        await cleanup();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        [...active].map(async ({ abort, cleanup }) => {
          abort();
          await cleanup();
        }),
      );
    },
  };
}
