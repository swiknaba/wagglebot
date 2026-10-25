import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ForgetMcpInputSchema,
  MemoryErrorCodeSchema,
  MemoryProposalMcpInputSchema,
  type MemoryProposalRequest,
  MemoryQueryMcpInputSchema,
  type MemorySearchInput,
  MemorySearchMcpInputSchema,
  RememberMcpInputSchema,
  type RememberRequest,
} from "../../../packages/contracts/src/memory";
import { type Principal, PrincipalError } from "./principal";
import { ScannerUnavailableError } from "./scanner";
import { MemoryServiceError } from "./write-service";

const MAX_BODY_BYTES = 1024 * 1024;
type WriteService = {
  remember(input: RememberRequest, principal: Principal): Promise<unknown>;
  propose(input: MemoryProposalRequest, principal: Principal): Promise<unknown>;
  invalidate(id: string, input: unknown, principal: Principal): Promise<unknown>;
};
type SearchService = {
  search(input: MemorySearchInput, principal: Principal): Promise<unknown>;
  get(id: string, principal: Principal): Promise<unknown>;
};

async function readLimited(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("request aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("request aborted", "AbortError");
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("request too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("request aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("request aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function errorPayload(error: unknown) {
  const proposedCode =
    error instanceof MemoryServiceError
      ? error.code
      : error instanceof z.ZodError
        ? "memory_invalid"
        : error instanceof PrincipalError
          ? "auth_invalid"
          : error instanceof ScannerUnavailableError
            ? "scanner_unavailable"
            : "memory_unavailable";
  const code = MemoryErrorCodeSchema.safeParse(proposedCode).success ? proposedCode : "memory_unavailable";
  return {
    schemaVersion: 1,
    error: {
      code,
      message: code.replaceAll("_", " "),
      correlationId: `corr_${randomUUID().replaceAll("-", "")}`,
      retryable: code === "memory_unavailable" || code === "scanner_unavailable",
    },
  };
}

function toolError(error: unknown) {
  return { isError: true, content: [], structuredContent: errorPayload(error) };
}

function serviceInput<T>(schema: z.ZodType<T>, value: unknown, addVersion = false): T | (T & { schemaVersion: 1 }) {
  const parsed = schema.parse(value);
  return addVersion ? ({ ...(parsed as object), schemaVersion: 1 } as T & { schemaVersion: 1 }) : parsed;
}

function preflightProposal(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const facts = (value as Record<string, unknown>).facts;
  if (!Array.isArray(facts)) return;
  for (const rawFact of facts) {
    if (typeof rawFact !== "object" || rawFact === null || Array.isArray(rawFact)) continue;
    const fact = rawFact as Record<string, unknown>;
    const scope = fact.scope;
    if (
      typeof scope === "object" &&
      scope !== null &&
      !Array.isArray(scope) &&
      (scope as Record<string, unknown>).kind !== "system"
    ) {
      throw new MemoryServiceError("agent_scope_forbidden", 403);
    }
    if (fact.wake === true) throw new MemoryServiceError("agent_wake_forbidden", 403);
  }
}

const tools = [
  {
    name: "memory_search",
    description: "Search scoped shared memory or retrieve bounded wake facts.",
    schema: MemorySearchMcpInputSchema,
  },
  {
    name: "memory_query",
    description: "Retrieve one registered memory record by UUID.",
    schema: MemoryQueryMcpInputSchema,
  },
  {
    name: "propose_memory",
    description: "Propose confirmed system-scope facts for shared memory.",
    schema: MemoryProposalMcpInputSchema,
  },
  { name: "remember", description: "Remember a governed shared-memory fact.", schema: RememberMcpInputSchema },
  { name: "forget", description: "Invalidate a shared-memory record by UUID.", schema: ForgetMcpInputSchema },
] as const;

export function createMemoryMcpApp(options: {
  resolvePrincipal: (token: string) => Promise<Principal>;
  writeService: WriteService;
  searchService: SearchService;
}) {
  const active = new Set<() => Promise<void>>();
  let closed = false;
  return {
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (closed)
        return Response.json(errorPayload(new MemoryServiceError("memory_unavailable", 503, true)), { status: 503 });
      const authorization = request.headers.get("authorization");
      if (!authorization || !authorization.startsWith("Bearer ") || authorization.length <= 7)
        return Response.json(errorPayload(new MemoryServiceError("auth_required", 401)), { status: 401 });
      let principal: Principal;
      try {
        principal = await options.resolvePrincipal(authorization.slice(7));
      } catch (error) {
        const payload = errorPayload(error);
        return Response.json(payload, { status: payload.error.code === "auth_invalid" ? 401 : 503 });
      }
      const lifecycle = new AbortController();
      const abortForDisconnect = () => lifecycle.abort();
      request.signal.addEventListener("abort", abortForDisconnect, { once: true });
      let server: Server | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => {
        cleanupPromise ??= (async () => {
          lifecycle.abort();
          await server?.close();
          request.signal.removeEventListener("abort", abortForDisconnect);
          active.delete(cleanup);
        })();
        return cleanupPromise;
      };
      active.add(cleanup);
      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        await cleanup();
        return Response.json(errorPayload(new MemoryServiceError("request_too_large", 413)), { status: 413 });
      }
      let body: Uint8Array;
      try {
        body = await untilAborted(readLimited(request, lifecycle.signal), lifecycle.signal);
      } catch (error) {
        await cleanup();
        if (error instanceof RangeError)
          return Response.json(errorPayload(new MemoryServiceError("request_too_large", 413)), { status: 413 });
        if (lifecycle.signal.aborted)
          return Response.json(errorPayload(new MemoryServiceError("memory_unavailable", 503, true)), { status: 503 });
        return Response.json(errorPayload(new MemoryServiceError("memory_invalid", 400)), { status: 400 });
      }
      const bounded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        signal: request.signal,
      });
      server = new Server({ name: "wagglebot-memory", version: "1" }, { capabilities: { tools: {} } });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map(({ name, description, schema }) => ({
          name,
          description,
          inputSchema: { ...z.toJSONSchema(schema), type: "object" },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          const args = request.params.arguments ?? {};
          switch (request.params.name) {
            case "memory_search": {
              const parsed = serviceInput(MemorySearchMcpInputSchema, args, true) as MemorySearchInput;
              return {
                content: [],
                structuredContent: (await options.searchService.search(parsed, principal)) as Record<string, unknown>,
              };
            }
            case "memory_query": {
              const parsed = serviceInput(MemoryQueryMcpInputSchema, args);
              return {
                content: [],
                structuredContent: (await options.searchService.get(parsed.id, principal)) as Record<string, unknown>,
              };
            }
            case "propose_memory": {
              preflightProposal(args);
              const parsed = serviceInput(MemoryProposalMcpInputSchema, args, true) as MemoryProposalRequest;
              return {
                content: [],
                structuredContent: (await options.writeService.propose(parsed, principal)) as Record<string, unknown>,
              };
            }
            case "remember": {
              const parsed = serviceInput(RememberMcpInputSchema, args, true) as RememberRequest;
              return {
                content: [],
                structuredContent: (await options.writeService.remember(parsed, principal)) as Record<string, unknown>,
              };
            }
            case "forget": {
              const parsed = serviceInput(ForgetMcpInputSchema, args);
              return {
                content: [],
                structuredContent: (await options.writeService.invalidate(
                  parsed.id,
                  { schemaVersion: 1, operationKey: parsed.operationKey, reason: parsed.reason },
                  principal,
                )) as Record<string, unknown>,
              };
            }
            default:
              return toolError(new MemoryServiceError("memory_invalid", 400));
          }
        } catch (error) {
          return toolError(error);
        }
      });
      try {
        await server.connect(transport);
        const response = await untilAborted(transport.handleRequest(bounded), lifecycle.signal);
        const responseBytes = response.body ? await new Response(response.body).arrayBuffer() : null;
        if (responseBytes && responseBytes.byteLength > MAX_BODY_BYTES)
          return Response.json(errorPayload(new MemoryServiceError("memory_unavailable", 503, true)), { status: 503 });
        return new Response(responseBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return Response.json(errorPayload(new MemoryServiceError("memory_unavailable", 503, true)), { status: 503 });
      } finally {
        await cleanup();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...active].map((cleanup) => cleanup()));
    },
  };
}
