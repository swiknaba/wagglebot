import {
  AuthChallengeRequestSchema,
  type AuthChallengeResponse,
  AuthSessionRequestSchema,
  type AuthSessionResponse,
} from "@wagglebot/contracts";
import { AuthRateLimitError } from "./issuer";

const MAX_REQUEST_BYTES = 32 * 1024;

type AuthEndpoints = {
  issueChallenge(input: {
    username: string;
    audience: "wagglebot-registry" | "wagglebot-memory" | "wagglebot-coordination";
    signal: AbortSignal;
  }): Promise<AuthChallengeResponse>;
  exchangeSignature(input: {
    challengeId: string;
    nonce: string;
    username: string;
    signature: string;
    signal: AbortSignal;
  }): Promise<AuthSessionResponse>;
};

type DependencyState = "ready" | "unavailable";

export function createApp(options: {
  issuer: AuthEndpoints;
  readiness: () => { catalog: DependencyState; signingKey: DependencyState };
  randomBytes?: (length: number) => Uint8Array;
}) {
  const randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/livez") {
        return Response.json({ schemaVersion: 1, status: "live" });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const dependencies = options.readiness();
        const ready = Object.values(dependencies).every((value) => value === "ready");
        return Response.json(
          { schemaVersion: 1, status: ready ? "ready" : "degraded", dependencies },
          { status: ready ? 200 : 503 },
        );
      }
      if (request.method !== "POST" || !["/v1/auth/challenge", "/v1/auth/session"].includes(url.pathname)) {
        return new Response(null, { status: 404 });
      }

      const body = await readJson(request).catch(() => undefined);
      if (url.pathname === "/v1/auth/challenge") {
        const parsed = AuthChallengeRequestSchema.safeParse(body);
        if (!parsed.success)
          return errorResponse(400, "auth_invalid", "authentication request is invalid", false, randomBytes);
        if (options.readiness().catalog !== "ready") {
          return errorResponse(503, "auth_unavailable", "authentication is unavailable", true, randomBytes);
        }
        try {
          return authResponse(await options.issuer.issueChallenge({ ...parsed.data, signal: request.signal }));
        } catch (error) {
          if (error instanceof AuthRateLimitError) {
            return errorResponse(429, "auth_rate_limited", "authentication rate limit exceeded", true, randomBytes);
          }
          return errorResponse(503, "auth_unavailable", "authentication is unavailable", true, randomBytes);
        }
      }

      const parsed = AuthSessionRequestSchema.safeParse(body);
      if (!parsed.success) return errorResponse(401, "auth_invalid", "authentication failed", false, randomBytes);
      try {
        return authResponse(await options.issuer.exchangeSignature({ ...parsed.data, signal: request.signal }));
      } catch {
        return errorResponse(401, "auth_invalid", "authentication failed", false, randomBytes);
      }
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    throw new Error("invalid request length");
  }
  if (!request.body) throw new Error("missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error("request body too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function authResponse(body: AuthChallengeResponse | AuthSessionResponse): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  randomBytes: (length: number) => Uint8Array,
): Response {
  const correlationId = `corr_${Buffer.from(randomBytes(16)).toString("base64url")}`;
  return Response.json(
    { schemaVersion: 1, error: { code, message, correlationId, retryable } },
    { status, headers: { "cache-control": "no-store" } },
  );
}
