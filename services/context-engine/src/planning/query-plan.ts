import type { BrainExplainInput, BrainSearchInput, BrainWakeInput, MemorySearchInput } from "@wagglebot/contracts";
import type { ContextSource } from "../retrieval/types";

export type ContextRequest =
  | { mode: "wake"; input: BrainWakeInput; sharedRequest?: Extract<MemorySearchInput, { purpose: "wake" | "query" }> }
  | { mode: "search"; input: BrainSearchInput; sharedRequest?: Extract<MemorySearchInput, { purpose: "query" }> }
  | { mode: "explain"; input: BrainExplainInput; sharedRequest?: Extract<MemorySearchInput, { purpose: "query" }> };

export type QueryPlan = {
  providers: ContextSource[];
  sharedPurpose?: "query" | "wake";
  providerDeadlinesMs: Partial<Record<ContextSource, number>>;
  candidateCaps: Partial<Record<ContextSource, number>>;
  aggregateDeadlineMs: number;
};

export const createQueryPlan = (request: ContextRequest): QueryPlan => {
  const level = request.mode === "wake" ? (request.input.level ?? 0) : undefined;
  const requestedSources = request.mode === "search" ? request.input.sources : undefined;
  const providers: ContextSource[] =
    request.mode === "wake" && level === 0
      ? []
      : request.mode === "explain" && !request.input.query
        ? ["local_memory", "code", "git"]
        : requestedSources !== undefined
          ? requestedSources
          : [
              "local_memory",
              "code",
              "git",
              ...(request.mode === "wake" && level !== undefined && level > 0
                ? ["shared_memory" as const]
                : request.mode !== "wake"
                  ? ["shared_memory" as const]
                  : []),
            ];
  const limits: Partial<Record<ContextSource, number>> = {
    local_memory: 100,
    code: 600,
    git: 1_200,
    shared_memory: 800,
  };
  const caps: Partial<Record<ContextSource, number>> = { local_memory: 10, code: 12, git: 10, shared_memory: 6 };
  if (request.mode === "wake" && level === 1) {
    caps.local_memory = 2;
    caps.git = 3;
    caps.shared_memory = 3;
  }
  if (request.mode === "wake" && level === 2) caps.shared_memory = 3;
  if (request.mode === "wake" && level === 3) caps.shared_memory = 8;
  if (request.mode === "wake" && level === 0) limits.local_memory = 0;
  return {
    providers,
    ...(providers.includes("shared_memory")
      ? { sharedPurpose: request.mode === "wake" && level === 1 ? "wake" : "query" }
      : {}),
    providerDeadlinesMs: Object.fromEntries(
      providers.map((provider) => [provider, limits[provider] ?? 100]),
    ) as Partial<Record<ContextSource, number>>,
    candidateCaps: Object.fromEntries(providers.map((provider) => [provider, caps[provider] ?? 6])) as Partial<
      Record<ContextSource, number>
    >,
    aggregateDeadlineMs:
      request.mode === "wake" && level === 1
        ? 750
        : request.mode === "wake" && typeof level === "number" && level >= 2
          ? 2_500
          : 1_500,
  };
};
