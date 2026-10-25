import type { DiscoveryState } from "@wagglebot/contracts";
import type { McpToolSchema } from "../upstream/types";

type DiscoveryCacheOptions = {
  now: () => Date;
  retrySeconds: number;
  refreshSeconds: number;
  ttlSeconds: number;
};

function initialState(): DiscoveryState {
  return {
    status: "unknown",
    toolCount: 0,
    tools: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastDiscoveryError: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
  };
}

function at(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export class DiscoveryCache {
  readonly #states = new Map<string, DiscoveryState>();

  public constructor(private readonly options: DiscoveryCacheOptions) {}

  public state(namespace: string): DiscoveryState {
    return structuredClone(this.#states.get(namespace) ?? initialState());
  }

  public states(): Map<string, DiscoveryState> {
    return new Map([...this.#states].map(([namespace, state]) => [namespace, structuredClone(state)]));
  }

  public begin(namespace: string): void {
    const state = this.#states.get(namespace) ?? initialState();
    this.#states.set(namespace, { ...state, status: "refreshing", lastAttemptAt: this.options.now().toISOString() });
  }

  public succeed(namespace: string, tools: McpToolSchema[]): void {
    const state = this.#states.get(namespace) ?? initialState();
    const timestamp = this.options.now().toISOString();
    this.#states.set(namespace, {
      ...state,
      status: tools.length === 0 ? "empty" : "ready",
      toolCount: tools.length,
      tools: structuredClone(tools),
      lastAttemptAt: timestamp,
      lastSuccessAt: timestamp,
      lastDiscoveryError: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
    });
  }

  public fail(namespace: string, error: string): void {
    const state = this.#states.get(namespace) ?? initialState();
    const failures = state.consecutiveFailures + 1;
    const delay = Math.min(this.options.retrySeconds * 2 ** (failures - 1), this.options.refreshSeconds);
    this.#states.set(namespace, {
      ...state,
      status: "error",
      lastDiscoveryError: error.slice(0, 1024),
      consecutiveFailures: failures,
      nextRetryAt: at(this.options.now(), delay),
    });
  }

  public remove(namespace: string): void {
    this.#states.delete(namespace);
  }

  public isFresh(namespace: string): boolean {
    const state = this.#states.get(namespace);
    if (!state || (state.status !== "ready" && state.status !== "empty") || state.lastSuccessAt === null) return false;
    return new Date(state.lastSuccessAt).getTime() + this.options.ttlSeconds * 1000 >= this.options.now().getTime();
  }

  public isDue(namespace: string): boolean {
    const state = this.#states.get(namespace);
    if (!state || state.status === "unknown") return true;
    if (state.status === "refreshing") return false;
    if (state.status === "error")
      return state.nextRetryAt !== null && new Date(state.nextRetryAt) <= this.options.now();
    if (state.lastAttemptAt === null) return true;
    return new Date(state.lastAttemptAt).getTime() + this.options.refreshSeconds * 1000 <= this.options.now().getTime();
  }
}
