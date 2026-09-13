import { readFile } from "node:fs/promises";
import { parseAllDocuments } from "yaml";

export type ResolvedPublicKey = {
  username: string;
  authorizedKey: string;
  fingerprint: string;
  source: "catalog" | "github";
};

export interface PublicKeyResolver {
  resolve(username: string, signal: AbortSignal): Promise<ResolvedPublicKey>;
  refresh(signal: AbortSignal): Promise<void>;
  ready(): boolean;
}

type CatalogUser = {
  kind?: unknown;
  metadata?: { name?: unknown; annotations?: unknown };
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_TYPE =
  /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const GITHUB_CACHE_MS = 15 * 60 * 1_000;

function normalizeKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid key");
  const [type, encoded] = value.trim().split(/\s+/, 3);
  if (!type || !encoded || !KEY_TYPE.test(type) || !BASE64.test(encoded)) throw new Error("invalid key");
  return `${type} ${encoded}`;
}

async function fingerprint(key: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("aborted");
  const process = Bun.spawn(["ssh-keygen", "-lf", "-", "-E", "sha256"], {
    stdin: new Blob([`${key}\n`]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error("invalid key");
  const match = output.match(/\b(SHA256:[A-Za-z0-9+/]+={0,2})\b/);
  if (!match?.[1]) throw new Error("invalid key");
  return match[1];
}

export function createCatalogPublicKeyResolver(options: { catalogPath: string }): PublicKeyResolver {
  let keys = new Map<string, ResolvedPublicKey>();
  let isReady = false;

  return {
    async resolve(username, signal) {
      if (signal.aborted) throw new Error("authentication failed");
      const key = keys.get(username);
      if (!key) throw new Error("authentication failed");
      return key;
    },
    async refresh(signal) {
      try {
        if (signal.aborted) throw new Error("aborted");
        const text = await readFile(options.catalogPath, "utf8");
        const candidate = new Map<string, ResolvedPublicKey>();
        const documents = parseAllDocuments(text).map((document) => document.toJS() as CatalogUser | null);
        for (const document of documents) {
          if (document?.kind !== "User") continue;
          const username = document.metadata?.name;
          if (typeof username !== "string" || !USERNAME.test(username) || candidate.has(username)) {
            throw new Error("invalid user");
          }
          const annotations = document.metadata?.annotations;
          if (!annotations || typeof annotations !== "object" || Array.isArray(annotations))
            throw new Error("invalid key");
          const key = normalizeKey((annotations as Record<string, unknown>)["wagglebot.dev/ssh-key"]);
          candidate.set(username, {
            username,
            authorizedKey: key,
            fingerprint: await fingerprint(key, signal),
            source: "catalog",
          });
        }
        if (candidate.size === 0) throw new Error("no users");
        keys = candidate;
        isReady = true;
      } catch {
        isReady = false;
        throw new Error("catalog key refresh failed");
      }
    },
    ready() {
      return isReady;
    },
  };
}

type GithubCacheEntry = { key: ResolvedPublicKey; expiresAtMs: number };

export function createGitHubPublicKeyResolver(options: {
  githubKeysHost: string;
  fetch?: Fetcher;
  clock?: () => Date;
}): PublicKeyResolver {
  const origin = githubKeysOrigin(options.githubKeysHost);
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const cache = new Map<string, GithubCacheEntry>();
  let isReady = false;

  return {
    async resolve(username, signal) {
      try {
        if (!USERNAME.test(username) || signal.aborted) throw new Error("invalid request");
        const cached = cache.get(username);
        if (cached && cached.expiresAtMs > clock().getTime()) return cached.key;

        const requestUrl = new URL(`/${username}.keys`, origin);
        const response = await fetcher(requestUrl, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
          redirect: "manual",
        });
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== origin.origin)) {
          throw new Error("invalid response");
        }
        const lines = (await response.text()).split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (lines.length !== 1) throw new Error("invalid response");
        const authorizedKey = normalizeKey(lines[0]);
        const key: ResolvedPublicKey = {
          username,
          authorizedKey,
          fingerprint: await fingerprint(authorizedKey, signal),
          source: "github",
        };
        cache.set(username, { key, expiresAtMs: clock().getTime() + GITHUB_CACHE_MS });
        isReady = true;
        return key;
      } catch {
        isReady = false;
        throw new Error("authentication failed");
      }
    },
    async refresh(signal) {
      if (signal.aborted) throw new Error("authentication failed");
    },
    ready() {
      return isReady;
    },
  };
}

function githubKeysOrigin(host: string): URL {
  try {
    const url = new URL(`https://${host}`);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid host");
    }
    return url;
  } catch {
    throw new Error("invalid GitHub keys host");
  }
}
