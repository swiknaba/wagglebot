import type { ProviderFailure } from "@wagglebot/contracts";
import type { ContextRequest, QueryPlan } from "../planning/query-plan";
import type { CodeGraphMetadata, ContextSource, RetrievalCandidate, RetrievalResult } from "./types";

export type ContextProviderResult =
  | RetrievalCandidate[]
  | { candidates: RetrievalCandidate[]; codeGraph?: CodeGraphMetadata };
export type ContextProvider = (request: ContextRequest, signal: AbortSignal) => Promise<ContextProviderResult>;
export type Providers = Partial<Record<ContextSource, ContextProvider>>;

const errorCode = (error: unknown): ProviderFailure["code"] => {
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  if (error instanceof Error && error.message === "provider_missing") return "missing";
  if (error instanceof Error && "code" in error && error.code === "unauthorized") return "unauthorized";
  if (error instanceof Error && "code" in error && error.code === "invalid_response") return "invalid_response";
  return "unavailable";
};

export const runRetrieval = async (
  plan: QueryPlan,
  request: ContextRequest,
  providers: Providers,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<RetrievalResult> => {
  if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  const aggregate = new AbortController();
  const stop = () => aggregate.abort(signal?.reason);
  signal?.addEventListener("abort", stop, { once: true });
  const aggregateTimer = setTimeout(
    () => aggregate.abort(new DOMException("deadline", "AbortError")),
    plan.aggregateDeadlineMs,
  );
  const tasks = plan.providers.map(async (provider) => {
    const providerStarted = now();
    const controller = new AbortController();
    const abort = () => controller.abort(aggregate.signal.reason);
    aggregate.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("deadline", "AbortError")),
      plan.providerDeadlinesMs[provider],
    );
    try {
      const run = providers[provider];
      if (!run) throw new Error("provider_missing");
      const result = run(request, controller.signal);
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      const providerResult = await Promise.race([result, aborted]);
      if (controller.signal.aborted || aggregate.signal.aborted)
        throw controller.signal.reason ?? new DOMException("deadline", "AbortError");
      const candidates = Array.isArray(providerResult) ? providerResult : providerResult.candidates;
      return {
        provider,
        candidates: candidates.slice(0, plan.candidateCaps[provider]),
        ...(!Array.isArray(providerResult) && providerResult.codeGraph ? { codeGraph: providerResult.codeGraph } : {}),
        elapsedMs: Math.max(0, now() - providerStarted),
      };
    } catch (error) {
      const failure: ProviderFailure = {
        provider,
        code: errorCode(error),
        elapsedMs: Math.max(0, now() - providerStarted),
      };
      return { provider, failure, candidates: [] as RetrievalCandidate[], elapsedMs: failure.elapsedMs };
    } finally {
      clearTimeout(timer);
      aggregate.signal.removeEventListener("abort", abort);
    }
  });
  const results = await Promise.all(tasks);
  clearTimeout(aggregateTimer);
  signal?.removeEventListener("abort", stop);
  if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  const degraded = results.flatMap((result) => ("failure" in result && result.failure ? [result.failure] : []));
  const codeGraphResult = results.find((result) => "codeGraph" in result && result.codeGraph);
  const codeGraph = codeGraphResult && "codeGraph" in codeGraphResult ? codeGraphResult.codeGraph : undefined;
  return {
    candidates: results.flatMap((result) => result.candidates),
    degraded,
    timings: Object.fromEntries(results.map((result) => [result.provider, result.elapsedMs])),
    ...(codeGraph ? { codeGraph } : {}),
  };
};
