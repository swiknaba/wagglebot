import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MemoryErrorCodeSchema } from "../../../packages/contracts/src/memory";
import { PublicationServiceError } from "./publication";
import { MemoryServiceError } from "./write-service";

const MAX_BODY_BYTES = 1024 * 1024;
const correlationPattern = /^[A-Za-z0-9._:-]{1,64}$/u;
const errorCodeSchema = MemoryErrorCodeSchema;

type AdminService = {
  rescan(input: unknown): Promise<unknown>;
  reindex(input: unknown): Promise<unknown>;
  runOnce(input: unknown): Promise<unknown>;
};
type PublicationService = { replaceSource(sourceKey: string, input: unknown): Promise<unknown> };

function equalSecret(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

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

function mappedError(error: unknown): { code: string; status: number; retryable: boolean } {
  if (error instanceof MemoryServiceError || error instanceof PublicationServiceError) {
    if (errorCodeSchema.safeParse(error.code).success)
      return { code: error.code, status: error.status, retryable: error.retryable };
  }
  if (error instanceof z.ZodError) return { code: "memory_invalid", status: 400, retryable: false };
  return { code: "memory_unavailable", status: 503, retryable: true };
}

export function createAdminHttpApp(options: {
  adminBearerToken: string;
  adminService: AdminService;
  publicationService: PublicationService;
}) {
  const errorResponse = (code: string, status: number, retryable: boolean, correlationId: string) =>
    Response.json(
      {
        schemaVersion: 1,
        error: { code, message: code.replaceAll("_", " "), correlationId, retryable },
      },
      { status },
    );

  return {
    async fetch(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const publicationMatch = request.method === "PUT" ? /^\/v1\/publications\/([^/]+)$/u.exec(url.pathname) : null;
      const route =
        publicationMatch !== null ||
        (request.method === "POST" &&
          ["/v1/admin/rescan", "/v1/admin/reindex", "/v1/admin/run-once"].includes(url.pathname));
      if (!route) return undefined;

      const rawCorrelation = request.headers.get("x-correlation-id");
      const correlationId =
        rawCorrelation && correlationPattern.test(rawCorrelation)
          ? rawCorrelation
          : `corr_${randomUUID().replaceAll("-", "")}`;
      const authorization = request.headers.get("authorization");
      if (!authorization || !authorization.startsWith("Bearer ") || authorization.length <= 7)
        return errorResponse("admin_auth_required", 401, false, correlationId);
      if (!equalSecret(options.adminBearerToken, authorization.slice(7)))
        return errorResponse("admin_auth_invalid", 401, false, correlationId);

      const length = Number(request.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES)
        return errorResponse("request_too_large", 413, false, correlationId);
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") return errorResponse("memory_invalid", 400, false, correlationId);

      let raw: unknown;
      try {
        const bytes = await readLimited(request);
        if (bytes === null) throw new SyntaxError("missing body");
        raw = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        if (error instanceof RangeError) return errorResponse("request_too_large", 413, false, correlationId);
        return errorResponse("memory_invalid", 400, false, correlationId);
      }

      try {
        let result: unknown;
        if (publicationMatch) {
          let sourceKey: string;
          try {
            const encodedSourceKey = publicationMatch[1];
            if (encodedSourceKey === undefined) throw new URIError("invalid source key");
            sourceKey = decodeURIComponent(encodedSourceKey);
          } catch {
            return errorResponse("publication_invalid", 400, false, correlationId);
          }
          result = await options.publicationService.replaceSource(sourceKey, raw);
        } else if (url.pathname === "/v1/admin/rescan") {
          result = await options.adminService.rescan(raw);
        } else if (url.pathname === "/v1/admin/reindex") {
          result = await options.adminService.reindex(raw);
        } else {
          result = await options.adminService.runOnce(raw);
        }
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
          return errorResponse("memory_unavailable", 503, true, correlationId);
        return new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
      } catch (error) {
        const mapped = mappedError(error);
        return errorResponse(mapped.code, mapped.status, mapped.retryable, correlationId);
      }
    },
  };
}
