import { randomUUID } from "node:crypto";
import type { D26Principal, RegistrySnapshot } from "@wagglebot/contracts";
import { composeRegistry } from "./compose";
import type { RegistrySource } from "./source";

type Verify = (token: string) => Promise<D26Principal>;
const errorBody = (code: string, retryable: boolean) => ({
  schemaVersion: 1,
  error: {
    code,
    message: code.startsWith("auth_")
      ? "authentication failed"
      : code === "registry_response_too_large"
        ? "registry response is too large"
        : "registry unavailable",
    correlationId: `corr_${randomUUID().replaceAll("-", "")}`,
    retryable,
  },
});

export function createApp(options: { source: RegistrySource; verify: Verify; maxResponseBytes?: number }) {
  const max = options.maxResponseBytes ?? 262_144;
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/livez")
        return Response.json({ schemaVersion: 1, status: "live" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        const ready = options.source.current() !== undefined && !options.source.isDegraded();
        return Response.json(
          {
            schemaVersion: 1,
            status: ready ? "ready" : "degraded",
            dependencies: { source: ready ? "ready" : "unavailable" },
          },
          { status: ready ? 200 : 503 },
        );
      }
      if (request.method !== "GET" || url.pathname !== "/registry") return new Response(null, { status: 404 });
      const header = request.headers.get("authorization");
      if (!header?.startsWith("Bearer ") || header.length <= 7)
        return Response.json(errorBody("auth_required", false), { status: 401 });
      let principal: D26Principal;
      try {
        principal = await options.verify(header.slice(7));
      } catch {
        return Response.json(errorBody("auth_invalid", false), { status: 401 });
      }
      const source = options.source.current();
      if (!source) return Response.json(errorBody("registry_unavailable", true), { status: 503 });
      let snapshot: RegistrySnapshot;
      try {
        snapshot = composeRegistry(principal, source);
      } catch {
        return Response.json(errorBody("registry_unavailable", true), { status: 503 });
      }
      const body = JSON.stringify(snapshot);
      if (new TextEncoder().encode(body).byteLength > max)
        return Response.json(errorBody("registry_response_too_large", false), { status: 413 });
      const headers = { "content-type": "application/json", "cache-control": "no-store", etag: snapshot.revision };
      if (request.headers.get("if-none-match") === snapshot.revision)
        return new Response(null, { status: 304, headers });
      return new Response(body, { status: 200, headers });
    },
  };
}
