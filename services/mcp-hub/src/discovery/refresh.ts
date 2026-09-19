import type { ProxyConfig } from "@wagglebot/contracts";
import type { ResolvedCredential } from "../credentials";
import type { UpstreamManager } from "../upstream/types";
import type { DiscoveryCache } from "./cache";

type DiscoverySchedulerOptions = {
  cache: DiscoveryCache;
  proxies: () => readonly ProxyConfig[];
  upstreams: UpstreamManager;
  credentialFor?: (proxy: ProxyConfig) => Promise<ResolvedCredential | null>;
  maxConcurrency: number;
  timeoutSeconds: number;
  refreshEnabled?: boolean;
  refreshIntervalSeconds?: number;
  warmupOnStart?: boolean;
};

function timeoutSignal(signal: AbortSignal, seconds: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000)]);
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("discovery aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DOMException("discovery aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class DiscoveryScheduler {
  readonly #inFlight = new Map<string, Promise<void>>();
  #controller?: AbortController;
  #timer?: ReturnType<typeof setInterval>;

  public constructor(private readonly options: DiscoverySchedulerOptions) {}

  public start(): void {
    if (this.#controller) return;
    this.#controller = new AbortController();
    if (this.options.warmupOnStart ?? true) void this.refreshAll(this.#controller.signal);
    if (this.options.refreshEnabled ?? true) {
      const interval = (this.options.refreshIntervalSeconds ?? 300) * 1000;
      this.#timer = setInterval(() => void this.refreshDue(this.#controller?.signal), interval);
    }
  }

  public async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled(this.#inFlight.values());
  }

  public async refreshAll(signal: AbortSignal = new AbortController().signal): Promise<void> {
    const proxies = this.options.proxies();
    await this.reconcile(proxies);
    await this.refresh(proxies, signal);
  }

  public async refreshDue(signal: AbortSignal = new AbortController().signal): Promise<void> {
    const proxies = this.options.proxies();
    await this.reconcile(proxies);
    await this.refresh(
      proxies.filter((proxy) => this.options.cache.isDue(proxy.namespace)),
      signal,
    );
  }

  private async reconcile(proxies: readonly ProxyConfig[]): Promise<void> {
    const active = new Set(proxies.map((proxy) => proxy.namespace));
    const removed = [...this.options.cache.states().keys()].filter((namespace) => !active.has(namespace));
    for (const namespace of removed) this.options.cache.remove(namespace);
    await this.options.upstreams.drain(removed);
  }

  private async refresh(proxies: readonly ProxyConfig[], signal: AbortSignal): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const proxy = proxies[next++];
        if (!proxy) return;
        await this.refreshNamespace(proxy, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.maxConcurrency, proxies.length) }, worker));
  }

  private refreshNamespace(proxy: ProxyConfig, signal: AbortSignal): Promise<void> {
    const running = this.#inFlight.get(proxy.namespace);
    if (running) return running;
    const refresh = this.doRefreshNamespace(proxy, signal).finally(() => this.#inFlight.delete(proxy.namespace));
    this.#inFlight.set(proxy.namespace, refresh);
    return refresh;
  }

  private async doRefreshNamespace(proxy: ProxyConfig, signal: AbortSignal): Promise<void> {
    this.options.cache.begin(proxy.namespace);
    try {
      const credential = this.options.credentialFor ? await this.options.credentialFor(proxy) : null;
      if (proxy.auth !== undefined && credential === null) {
        this.options.cache.fail(proxy.namespace, "upstream credential unavailable");
        return;
      }
      const discoverySignal = timeoutSignal(signal, this.options.timeoutSeconds);
      const tools = await untilAborted(
        this.options.upstreams.withClient(proxy, credential ?? null, discoverySignal, (client) =>
          client.listTools(discoverySignal),
        ),
        discoverySignal,
      );
      this.options.cache.succeed(proxy.namespace, tools);
    } catch {
      this.options.cache.fail(proxy.namespace, "upstream unavailable");
    }
  }
}
