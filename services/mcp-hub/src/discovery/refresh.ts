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
  readonly #namespaceControllers = new Map<string, AbortController>();
  readonly #identities = new Map<string, string>();
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
    for (const controller of this.#namespaceControllers.values()) controller.abort();
    await Promise.allSettled(this.#inFlight.values());
  }

  public async refreshAll(
    signal: AbortSignal = this.#controller?.signal ?? new AbortController().signal,
  ): Promise<void> {
    const proxies = this.options.proxies();
    await this.reconcile(proxies);
    await this.refresh(proxies, signal);
  }

  public async refreshDue(
    signal: AbortSignal = this.#controller?.signal ?? new AbortController().signal,
  ): Promise<void> {
    const proxies = this.options.proxies();
    await this.reconcile(proxies);
    await this.refresh(
      proxies.filter((proxy) => this.options.cache.isDue(proxy.namespace)),
      signal,
    );
  }

  private async reconcile(proxies: readonly ProxyConfig[]): Promise<void> {
    const current = new Map(proxies.map((proxy) => [proxy.namespace, JSON.stringify(proxy)]));
    const invalidated = [...this.#identities]
      .filter(([namespace, identity]) => current.get(namespace) !== identity)
      .map(([namespace]) => namespace);
    await this.invalidate(invalidated);
    this.#identities.clear();
    for (const [namespace, identity] of current) this.#identities.set(namespace, identity);
  }

  public async invalidate(namespaces: Iterable<string>): Promise<void> {
    const invalidated = [...new Set(namespaces)];
    for (const namespace of invalidated) this.#namespaceControllers.get(namespace)?.abort();
    await Promise.allSettled(
      invalidated.flatMap((namespace) => {
        const active = this.#inFlight.get(namespace);
        return active ? [active] : [];
      }),
    );
    for (const namespace of invalidated) this.options.cache.remove(namespace);
    await this.options.upstreams.drain(invalidated);
  }

  private async refresh(proxies: readonly ProxyConfig[], signal: AbortSignal): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const proxy = proxies[next++];
        if (!proxy) return;
        while (this.#inFlight.size >= this.options.maxConcurrency && !signal.aborted) {
          await Promise.race(this.#inFlight.values());
        }
        if (signal.aborted) return;
        await this.refreshNamespace(proxy, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.maxConcurrency, proxies.length) }, worker));
  }

  private refreshNamespace(proxy: ProxyConfig, signal: AbortSignal): Promise<void> {
    const running = this.#inFlight.get(proxy.namespace);
    if (running) return running;
    const controller = new AbortController();
    const namespaceSignal = AbortSignal.any([signal, controller.signal]);
    this.#namespaceControllers.set(proxy.namespace, controller);
    const refresh = this.doRefreshNamespace(proxy, namespaceSignal).finally(() => {
      this.#inFlight.delete(proxy.namespace);
      this.#namespaceControllers.delete(proxy.namespace);
    });
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
