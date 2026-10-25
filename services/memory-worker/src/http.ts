import { randomUUID } from "node:crypto";
import type {
  GetMemoryResponse,
  InvalidateResponse,
  MemoryProposalRequest,
  MemorySearchInput,
  RememberRequest,
  WriteResult,
} from "../../../packages/contracts/src/memory";
import { type Principal, PrincipalError } from "./principal";
import { MemoryServiceError } from "./write-service";

const MAX_BODY_BYTES = 1024 * 1024;
const correlationPattern = /^[A-Za-z0-9._:-]{1,64}$/u;

type WriteService = {
  remember(input: RememberRequest, principal: Principal): Promise<WriteResult>;
  propose(input: MemoryProposalRequest, principal: Principal): Promise<WriteResult>;
  invalidate(id: string, input: unknown, principal: Principal): Promise<InvalidateResponse>;
};
type SearchService = {
  search(input: MemorySearchInput, principal: Principal): Promise<unknown>;
  get(id: string, principal: Principal): Promise<GetMemoryResponse>;
};

async function readLimited(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("request too large");
      }
      chunks.push(value);
    }
  } finally {
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

function errorCode(error: unknown): { code: string; status: number; retryable: boolean } {
  if (error instanceof MemoryServiceError)
    return { code: error.code, status: error.status, retryable: error.retryable };
  if (error instanceof PrincipalError) return { code: "auth_invalid", status: 401, retryable: false };
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (code === "scanner_unavailable") return { code, status: 503, retryable: true };
    if (code === "auth_invalid") return { code, status: 401, retryable: false };
  }
  return { code: "memory_unavailable", status: 503, retryable: true };
}

export function createMemoryHttpApp(options: {
  resolvePrincipal: (token: string) => Promise<Principal>;
  writeService: WriteService;
  searchService: SearchService;
  ready?: () => Promise<void>;
  health?: () => Promise<{
    status: "ready" | "degraded";
    dependencies: Record<string, string>;
  }>;
}) {
  const errorResponse = (code: string, status: number, retryable: boolean, correlationId: string) =>
    Response.json(
      {
        schemaVersion: 1,
        error: {
          code,
          message: code.replaceAll("_", " "),
          correlationId,
          retryable,
        },
      },
      { status },
    );
  const successResponse = (value: unknown, correlationId: string): Response => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
      return errorResponse("memory_unavailable", 503, true, correlationId);
    return new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const rawCorrelation = request.headers.get("x-correlation-id");
      const correlationId =
        rawCorrelation && correlationPattern.test(rawCorrelation)
          ? rawCorrelation
          : `corr_${randomUUID().replaceAll("-", "")}`;
      if (request.method === "GET" && url.pathname === "/livez")
        return Response.json({ schemaVersion: 1, status: "live" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        try {
          await options.ready?.();
          const health = await options.health?.();
          const status = health?.status ?? "ready";
          return Response.json(
            {
              schemaVersion: 1,
              status,
              dependencies: health?.dependencies ?? { database: "ready", embedding: "ready" },
            },
            { status: status === "ready" ? 200 : 503 },
          );
        } catch {
          return Response.json(
            { schemaVersion: 1, status: "degraded", dependencies: { database: "unavailable", embedding: "ready" } },
            { status: 503 },
          );
        }
      }

      const method = request.method;
      const pathname = url.pathname;
      const route =
        (method === "POST" && ["/v1/memory/proposals", "/v1/memories", "/v1/memory/search"].includes(pathname)) ||
        (method === "POST" && /^\/v1\/memories\/[^/]+\/invalidate$/u.test(pathname)) ||
        (method === "GET" && /^\/v1\/memories\/[^/]+$/u.test(pathname));
      if (!route) return new Response(null, { status: 404 });

      const authorization = request.headers.get("authorization");
      if (!authorization || !authorization.startsWith("Bearer ") || authorization.length <= 7)
        return errorResponse("auth_required", 401, false, correlationId);
      let principal: Principal;
      try {
        principal = await options.resolvePrincipal(authorization.slice(7));
      } catch (error) {
        const mapped = errorCode(error);
        return errorResponse(mapped.code, mapped.status, mapped.retryable, correlationId);
      }

      if (method === "GET") {
        let id: string;
        try {
          id = decodeURIComponent(pathname.slice("/v1/memories/".length));
        } catch {
          return errorResponse("memory_invalid", 400, false, correlationId);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))
          return errorResponse("memory_invalid", 400, false, correlationId);
        try {
          return successResponse(await options.searchService.get(id, principal), correlationId);
        } catch (error) {
          const mapped = errorCode(error);
          return errorResponse(mapped.code, mapped.status, mapped.retryable, correlationId);
        }
      }

      const length = Number(request.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES)
        return errorResponse("request_too_large", 413, false, correlationId);
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") return errorResponse("memory_invalid", 400, false, correlationId);
      let raw: unknown;
      try {
        const body = await readLimited(request);
        if (body === null) throw new SyntaxError("missing body");
        raw = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        if (error instanceof RangeError) return errorResponse("request_too_large", 413, false, correlationId);
        return errorResponse("memory_invalid", 400, false, correlationId);
      }

      try {
        if (pathname === "/v1/memory/proposals")
          return successResponse(
            await options.writeService.propose(raw as MemoryProposalRequest, principal),
            correlationId,
          );
        if (pathname === "/v1/memories")
          return successResponse(await options.writeService.remember(raw as RememberRequest, principal), correlationId);
        if (pathname === "/v1/memory/search")
          return successResponse(
            await options.searchService.search(raw as MemorySearchInput, principal),
            correlationId,
          );
        const match = /^\/v1\/memories\/([^/]+)\/invalidate$/u.exec(pathname);
        if (match) {
          const matchedId = match[1];
          if (matchedId === undefined) throw new MemoryServiceError("memory_invalid", 400);
          let id: string;
          try {
            id = decodeURIComponent(matchedId);
          } catch {
            throw new MemoryServiceError("memory_invalid", 400);
          }
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))
            throw new MemoryServiceError("memory_invalid", 400);
          return successResponse(await options.writeService.invalidate(id, raw, principal), correlationId);
        }
      } catch (error) {
        const mapped = errorCode(error);
        return errorResponse(mapped.code, mapped.status, mapped.retryable, correlationId);
      }
      return new Response(null, { status: 404 });
    },
  };
}
