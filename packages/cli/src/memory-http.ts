import { MemoryErrorEnvelopeSchema } from "@wagglebot/contracts";

const MAX_BYTES = 1024 * 1024;
export type MemoryFetch = (url: string, init: RequestInit) => Promise<Response>;

export class MemoryClientError extends Error {}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new MemoryClientError("memory_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new MemoryClientError("memory_unavailable");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function createMemoryAdminClient(input: { env: NodeJS.ProcessEnv; fetch?: MemoryFetch }) {
  let endpoint: URL;
  try {
    endpoint = new URL(input.env.MEMORY_WORKER_URL ?? "");
  } catch {
    throw new MemoryClientError("MEMORY_WORKER_URL must be an HTTPS origin or an explicit loopback HTTP origin");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new MemoryClientError("MEMORY_WORKER_URL must be an HTTPS origin or an explicit loopback HTTP origin");
  const token = input.env.MEMORY_ADMIN_BEARER_TOKEN;
  if (!token?.trim() || /[\r\n]/u.test(token)) throw new MemoryClientError("MEMORY_ADMIN_BEARER_TOKEN is required");
  const request = input.fetch ?? globalThis.fetch;
  return {
    async send<T>(
      method: "POST" | "PUT",
      path: string,
      value: unknown,
      schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    ): Promise<T> {
      try {
        const body = JSON.stringify(value);
        if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new MemoryClientError("request_too_large");
        const response = await request(new URL(path, endpoint).href, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        const raw = await readJson(response);
        if (!response.ok) {
          const error = MemoryErrorEnvelopeSchema.safeParse(raw);
          throw new MemoryClientError(error.success ? error.data.error.code : "memory_unavailable");
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new MemoryClientError("memory_unavailable");
        return parsed.data;
      } catch (error) {
        if (error instanceof MemoryClientError) throw error;
        throw new MemoryClientError("memory_unavailable");
      }
    },
  };
}
