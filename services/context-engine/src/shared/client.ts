import { randomUUID } from "node:crypto";
import type { SessionTokenProvider } from "@wagglebot/auth-protocol";
import {
  type MemorySearchInput,
  MemorySearchInputSchema,
  type MemorySearchResult,
  MemorySearchResultSchema,
} from "@wagglebot/contracts";
import { scanText } from "@wagglebot/secret-scanner";

const MAX_BYTES = 1024 * 1024;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
export class SharedMemoryClientError extends Error {
  constructor(readonly code: "unavailable" | "unauthorized" | "invalid_response" | "restricted") {
    super(code);
  }
}

export type SharedMemoryClient = {
  search(input: Extract<MemorySearchInput, { purpose: "query" }>, signal: AbortSignal): Promise<MemorySearchResult>;
  wake(input: Extract<MemorySearchInput, { purpose: "wake" }>, signal: AbortSignal): Promise<MemorySearchResult>;
  status(signal: AbortSignal): Promise<{ state: "ready" | "degraded" | "missing"; observedAt: string }>;
};
export type SharedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const clipped = (text: string, max: number): string => Array.from(text).slice(0, max).join("");

export function isShareableQuery(query: string): boolean {
  if (/```|~~~|(?:^|\s)\/[^\s]+|\b[A-Za-z]:[\\/][^\s]+/u.test(query)) return false;
  if (scanText(query).count > 0) return false;
  for (const match of query.matchAll(/\b[A-Za-z0-9_+/.=-]{32,}\b/gu)) {
    const token = match[0];
    const frequencies = new Map<string, number>();
    for (const character of token) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
      const probability = count / token.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_+/.=-]/u].filter((pattern) => pattern.test(token)).length;
    if (entropy >= 3.5 && classes >= 3) return false;
  }
  return true;
}

async function readJsonLimited(response: Response): Promise<unknown> {
  if (!response.body) throw new SharedMemoryClientError("invalid_response");
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
        throw new SharedMemoryClientError("invalid_response");
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SharedMemoryClientError("invalid_response");
  }
}

export function createSharedMemoryClient(options: {
  baseUrl: string;
  tokens: SessionTokenProvider;
  fetch?: SharedFetch;
  now?: () => Date;
}): SharedMemoryClient {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new SharedMemoryClientError("unavailable");
  }
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopbackHosts.has(base.hostname))) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new SharedMemoryClientError("unavailable");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const send = async (body: MemorySearchInput, signal: AbortSignal): Promise<MemorySearchResult> => {
    const parsedInput = MemorySearchInputSchema.safeParse(body);
    if (!parsedInput.success) throw new SharedMemoryClientError("invalid_response");
    if (parsedInput.data.purpose === "query" && !isShareableQuery(parsedInput.data.query))
      throw new SharedMemoryClientError("restricted");
    try {
      let token = await options.tokens.get("wagglebot-memory", signal);
      let response = await fetcher(new URL("/v1/memory/search", base), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.token}`,
          "x-correlation-id": `ctx_${randomUUID().replaceAll("-", "")}`,
        },
        body: JSON.stringify(parsedInput.data),
        redirect: "error",
        signal,
      });
      if (response.status === 401) {
        options.tokens.invalidate("wagglebot-memory");
        token = await options.tokens.get("wagglebot-memory", signal);
        response = await fetcher(new URL("/v1/memory/search", base), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token.token}`,
            "x-correlation-id": `ctx_${randomUUID().replaceAll("-", "")}`,
          },
          body: JSON.stringify(parsedInput.data),
          redirect: "error",
          signal,
        });
      }
      if (response.status === 401 || response.status === 403) throw new SharedMemoryClientError("unauthorized");
      if (!response.ok) throw new SharedMemoryClientError("unavailable");
      const parsed = MemorySearchResultSchema.safeParse(await readJsonLimited(response));
      if (!parsed.success) throw new SharedMemoryClientError("invalid_response");
      return parsed.data;
    } catch (error) {
      if (error instanceof SharedMemoryClientError) throw error;
      throw new SharedMemoryClientError("unavailable");
    }
  };

  return {
    search: (input, signal) => send({ ...input, query: clipped(input.query, 2_000) }, signal),
    async wake(input, signal) {
      const result = await send({ ...input, limit: Math.min(3, input.limit ?? 3) as 1 | 2 | 3 }, signal);
      const today = now().toISOString().slice(0, 10);
      return {
        ...result,
        records: result.records.filter(
          ({ record }) =>
            record.status === "active" &&
            record.confidence === "high" &&
            record.wake &&
            (record.reviewAfter === undefined || record.reviewAfter >= today),
        ),
      };
    },
    async status(signal) {
      const observedAt = now().toISOString();
      try {
        const response = await fetcher(new URL("/readyz", base), { redirect: "error", signal });
        if (response.status === 404) return { state: "missing", observedAt };
        if (!response.ok) return { state: "degraded", observedAt };
        const body = (await readJsonLimited(response)) as { status?: unknown };
        return { state: body.status === "ready" ? "ready" : "degraded", observedAt };
      } catch {
        return { state: "degraded", observedAt };
      }
    },
  };
}
