import { readFile, stat } from "node:fs/promises";
import type { SessionTokenProvider } from "@wagglebot/auth-protocol";
import { type HubConfig, type RegistrySnapshot, RegistrySnapshotSchema } from "@wagglebot/contracts";
import type { TrustStore } from "./trust";

const MAX_RESPONSE_BYTES = 262_144;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RefreshResult = { ok: true; snapshot: RegistrySnapshot } | { ok: false; error: Error };

export class RegistryManager {
  private snapshot?: RegistrySnapshot;
  private etag?: string;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<RefreshResult>;
  public constructor(
    private readonly input: {
      config: HubConfig;
      trust: TrustStore;
      tokens?: SessionTokenProvider;
      fetch?: Fetcher;
      readFile?: (path: string) => Promise<string>;
      stat?: (path: string) => Promise<{ mode: number }>;
    },
  ) {}

  public current(): RegistrySnapshot | undefined {
    return this.snapshot;
  }
  public start(): void {
    if (this.input.config.configUrl === undefined || this.input.config.configRefreshSeconds === 0 || this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.input.config.configRefreshSeconds * 1000);
  }
  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  public refresh(signal?: AbortSignal): Promise<RefreshResult> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(signal).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async doRefresh(signal?: AbortSignal): Promise<RefreshResult> {
    try {
      const candidate = this.input.config.configUrl ? await this.loadRemote(signal) : await this.loadLocal();
      if (candidate === this.snapshot) return { ok: true, snapshot: candidate };
      const snapshot = {
        ...candidate,
        proxies: candidate.proxies.filter((proxy) => this.input.trust.requireApproval(proxy)),
      };
      this.snapshot = snapshot;
      return { ok: true, snapshot };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause : new Error("registry refresh failed") };
    }
  }
  private async loadLocal(): Promise<RegistrySnapshot> {
    const path = this.input.config.configPath;
    if (!path) throw new Error("local registry path is missing");
    const metadata = await (this.input.stat ?? stat)(path);
    if ((metadata.mode & 0o077) !== 0) throw new Error("local registry file must be mode 0600 or stricter");
    const text = await (this.input.readFile ?? ((value) => readFile(value, "utf8")))(path);
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
      throw new Error("local registry file is too large");
    return parseSnapshot(text);
  }
  private async loadRemote(signal?: AbortSignal): Promise<RegistrySnapshot> {
    const url = new URL(this.input.config.configUrl as string);
    const tokens = this.input.tokens;
    if (!tokens) throw new Error("authentication token provider is required for remote registry");
    const token = await tokens.get("wagglebot-registry", signal ?? new AbortController().signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await (this.input.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${token.token}`, ...(this.etag ? { "if-none-match": this.etag } : {}) },
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (response.status === 304 && this.snapshot) return this.snapshot;
      if (!response.ok) throw new Error("remote registry request failed");
      const text = await readLimited(response, MAX_RESPONSE_BYTES);
      const snapshot = parseSnapshot(text);
      this.etag = response.headers.get("etag") ?? snapshot.revision;
      return snapshot;
    } finally {
      clearTimeout(timeout);
    }
  }
}
function parseSnapshot(text: string): RegistrySnapshot {
  return RegistrySnapshotSchema.parse(JSON.parse(text));
}

async function readLimited(response: Response, maximum: number): Promise<string> {
  if (response.body === null) throw new Error("remote registry response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("remote registry response is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
