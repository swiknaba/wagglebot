import type { DiscoveryCache } from "./discovery/cache";

type AvailableNamespace = {
  namespace: string;
  status: "ready" | "empty";
  toolCount: number;
  lastSuccessAt: string | null;
  nextRetryAt: string | null;
};

export class Introspection {
  public constructor(private readonly cache: DiscoveryCache) {}

  public listAvailableMcps(): { schemaVersion: 1; namespaces: AvailableNamespace[] } {
    const namespaces = [...this.cache.states()]
      .flatMap(([namespace, state]) =>
        state.status === "ready" || state.status === "empty"
          ? [
              {
                namespace,
                status: state.status,
                toolCount: state.toolCount,
                lastSuccessAt: state.lastSuccessAt,
                nextRetryAt: state.nextRetryAt,
              },
            ]
          : [],
      )
      .sort((left, right) => left.namespace.localeCompare(right.namespace));
    return { schemaVersion: 1, namespaces };
  }
}
