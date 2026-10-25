import { randomBytes } from "node:crypto";
import type { ProjectIdentity } from "@wagglebot/contracts";
import {
  type BrainExplainInput,
  BrainExplainInputSchema,
  type BrainSearchInput,
  BrainSearchInputSchema,
  type BrainStatusResult,
  BrainStatusResultSchema,
  type BrainWakeInput,
  BrainWakeInputSchema,
  CONTEXT_TOKEN_LIMITS,
  type ContextItem,
  type ContextPacket,
  ContextPacketSchema,
  MemorySearchInputSchema,
  type ProviderFailure,
} from "@wagglebot/contracts";
import type { LocalBrain } from "@wagglebot/local-brain";
import { ContextBudgetError, fitContextPacket } from "./context/budget";
import { ContextCursorCache } from "./context/cursor";
import { clipExcerpt } from "./context/representation";
import { type ContextRequest, createQueryPlan } from "./planning/query-plan";
import { findConflicts } from "./ranking/conflicts";
import { dedupeCandidates } from "./ranking/dedupe";
import { rankCandidates } from "./ranking/rrf";
import { createLocalProviders } from "./retrieval/local-providers";
import { runRetrieval } from "./retrieval/run";
import type { ContextSource, RankedCandidate } from "./retrieval/types";
import type { SharedMemoryClient } from "./shared/client";

export class ContextEngineError extends Error {
  constructor(
    readonly code: "context_invalid" | "context_unavailable" | "project_not_found",
    message: string,
  ) {
    super(message);
  }
}

const DEFAULTS = { wakeL0: 100, wakeL1: 350, wakeL2: 800, wakeL3: 3_000, search: 800, explain: 1_200 };
const codePoints = (text: string): number => Array.from(text).length;
const newId = (prefix: string): string => `${prefix}${randomBytes(16).toString("base64url")}`;
const freezeSharedRequest = (
  request: NonNullable<ContextRequest["sharedRequest"]>,
): NonNullable<ContextRequest["sharedRequest"]> =>
  Object.freeze({ ...request, cascade: Object.freeze({ ...request.cascade }) }) as NonNullable<
    ContextRequest["sharedRequest"]
  >;

const sharedRequestFor = (
  request: ContextRequest,
  project: ContextPacket["project"],
): ContextRequest["sharedRequest"] => {
  if (!project.system) return undefined;
  const cascade = Object.freeze({
    system: project.system,
    ...(project.domain ? { domain: project.domain } : {}),
    includeOrg: true as const,
  });
  if (request.mode === "wake") {
    if (request.input.level === 0) return undefined;
    if (request.input.level === 1 || request.input.level === undefined) {
      return freezeSharedRequest(
        MemorySearchInputSchema.parse({ schemaVersion: 1, purpose: "wake", cascade, limit: 3 }) as NonNullable<
          ContextRequest["sharedRequest"]
        >,
      );
    }
    if (!request.input.task) return undefined;
    return freezeSharedRequest(
      MemorySearchInputSchema.parse({
        schemaVersion: 1,
        purpose: "query",
        query: Array.from(request.input.task).slice(0, 2_000).join(""),
        cascade: Object.freeze({ ...(project.component ? { component: project.component } : {}), ...cascade }),
        limit: 6,
      }) as NonNullable<ContextRequest["sharedRequest"]>,
    );
  }
  const query = request.mode === "search" ? request.input.query : request.input.query;
  if (!query) return undefined;
  return freezeSharedRequest(
    MemorySearchInputSchema.parse({
      schemaVersion: 1,
      purpose: "query",
      query: Array.from(query).slice(0, 2_000).join(""),
      cascade: Object.freeze({ ...(project.component ? { component: project.component } : {}), ...cascade }),
      limit: 6,
    }) as NonNullable<ContextRequest["sharedRequest"]>,
  );
};

const itemFromCandidate = (candidate: RankedCandidate, sharedBudget: { remaining: number }): ContextItem => {
  const max = candidate.source === "shared_memory" ? sharedBudget.remaining : 2_000;
  const excerpt = clipExcerpt(candidate.content, max);
  sharedBudget.remaining -= candidate.source === "shared_memory" ? codePoints(excerpt.text) : 0;
  const channelRanks = new Map<string, number>();
  for (const channel of candidate.channels) {
    channelRanks.set(channel.name, Math.min(channelRanks.get(channel.name) ?? Number.MAX_SAFE_INTEGER, channel.rank));
  }
  return {
    id: candidate.id,
    source: candidate.source,
    ...(candidate.scope ? { scope: candidate.scope } : {}),
    kind: candidate.kind,
    title: candidate.title,
    excerpt: excerpt.text,
    provenance: candidate.provenance,
    freshness: candidate.freshness,
    channelRanks: Object.fromEntries(channelRanks),
    fusedScore: candidate.fusedScore,
    authorityTier: candidate.authorityTier,
  };
};

export type ContextEngine = {
  wake(input: BrainWakeInput, signal?: AbortSignal): Promise<ContextPacket>;
  search(input: BrainSearchInput, signal?: AbortSignal): Promise<ContextPacket>;
  explain(input: BrainExplainInput, signal?: AbortSignal): Promise<ContextPacket>;
  status(input: { projectPath: string }, signal?: AbortSignal): Promise<BrainStatusResult>;
  close(): Promise<void>;
};

export const createContextEngine = (
  brain: LocalBrain,
  options: {
    shared?: SharedMemoryClient;
    now?: () => Date;
    monotonicNow?: () => number;
    cursorCache?: ContextCursorCache;
  } = {},
): ContextEngine => {
  const now = options.now ?? (() => new Date());
  const providers = createLocalProviders(brain, options.shared);
  const cursors = options.cursorCache ?? new ContextCursorCache(() => (options.monotonicNow ?? Date.now)());

  const run = async (
    request: ContextRequest,
    rawInput: BrainWakeInput | BrainSearchInput | BrainExplainInput,
    signal?: AbortSignal,
  ): Promise<ContextPacket> => {
    const projectPath = rawInput.projectPath;
    let project: ProjectIdentity;
    try {
      project = await brain.identify(projectPath);
    } catch {
      throw new ContextEngineError("project_not_found", "Project identity is unavailable.");
    }
    const plan = createQueryPlan(request);
    const sharedRequest = plan.providers.includes("shared_memory") ? sharedRequestFor(request, project) : undefined;
    const preparedRequest = Object.freeze({ ...request, sharedRequest }) as ContextRequest;
    const retrieval = await runRetrieval(plan, preparedRequest, providers, options.monotonicNow, signal);
    const afterRetrieval = plan.providers.length === 0 ? project : await brain.identify(projectPath);
    const checkoutChanged = project.head !== afterRetrieval.head || project.workingTree !== afterRetrieval.workingTree;
    project = afterRetrieval;
    if (checkoutChanged) {
      retrieval.candidates = retrieval.candidates.map((candidate) =>
        candidate.source !== "code"
          ? candidate
          : {
              ...candidate,
              freshness: "stale",
              provenance: candidate.provenance.map((reference) =>
                reference.kind === "code" ? { ...reference, graphState: "stale" } : reference,
              ),
            },
      );
    }
    if (plan.providers.length > 0 && retrieval.degraded.length === plan.providers.length) {
      throw new ContextEngineError("context_unavailable", "No context providers are available.");
    }
    const ranked = rankCandidates(retrieval.candidates);
    const conflicts = findConflicts(ranked);
    const conflictItems = new Set(conflicts.flatMap(({ itemIds }) => itemIds));
    const deduped = dedupeCandidates(ranked);
    const effectiveCursor = "cursor" in rawInput ? rawInput.cursor : undefined;
    const cursor = cursors.prepare(
      effectiveCursor,
      deduped.items.map(({ id, contentHash }) => ({ id, contentHash })),
    );
    const byId = new Map(deduped.items.map((item) => [item.id, item]));
    let selected = cursor.candidates.flatMap(({ id }) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    const isWarning = (candidate: RankedCandidate): boolean => candidate.kind.toLowerCase() === "warning";

    const mode = request.mode;
    const level = mode === "wake" ? (request.input.level ?? 0) : undefined;
    const hardMax =
      mode === "wake"
        ? level === 0
          ? CONTEXT_TOKEN_LIMITS.wakeL0.hardMax
          : level === 1
            ? CONTEXT_TOKEN_LIMITS.wakeL1.hardMax
            : level === 2
              ? CONTEXT_TOKEN_LIMITS.wakeL2.hardMax
              : CONTEXT_TOKEN_LIMITS.wakeL3.hardMax
        : mode === "search"
          ? CONTEXT_TOKEN_LIMITS.search.hardMax
          : CONTEXT_TOKEN_LIMITS.explain.hardMax;
    const defaultMax =
      mode === "wake"
        ? level === 0
          ? DEFAULTS.wakeL0
          : level === 1
            ? DEFAULTS.wakeL1
            : level === 2
              ? DEFAULTS.wakeL2
              : DEFAULTS.wakeL3
        : mode === "search"
          ? DEFAULTS.search
          : DEFAULTS.explain;
    const requestMax = "maxTokens" in rawInput ? rawInput.maxTokens : undefined;
    const remaining = "remainingContextTokens" in rawInput ? rawInput.remainingContextTokens : undefined;
    const budget = Math.min(
      requestMax ?? defaultMax,
      hardMax,
      remaining === undefined ? hardMax : Math.floor(remaining * 0.05),
    );
    if (budget < 1) throw new ContextEngineError("context_invalid", "The requested response budget is infeasible.");
    const explicitLimit = mode === "search" ? (request.input.limit ?? 6) : undefined;
    const maxItems =
      mode === "wake"
        ? level === 0
          ? 0
          : level === 1
            ? 8
            : level === 2
              ? 6
              : 20
        : mode === "search"
          ? (explicitLimit ?? 6)
          : 8;
    const sharedMax =
      mode === "wake" ? (level === 0 ? 0 : level === 1 || level === 2 ? 3 : 8) : mode === "search" ? 3 : 3;
    const selectedItems: RankedCandidate[] = [];
    const counts: Partial<Record<ContextSource, number>> = {};
    let sharedCount = 0;
    for (const candidate of [...selected].sort(
      (a, b) =>
        Number(isWarning(b) || conflictItems.has(b.id)) - Number(isWarning(a) || conflictItems.has(a.id)) ||
        Number(b.exactMatch) - Number(a.exactMatch) ||
        b.fusedScore - a.fusedScore,
    )) {
      if (selectedItems.length >= maxItems) break;
      if (candidate.source === "shared_memory" && sharedCount >= sharedMax) continue;
      if (mode === "wake" && level === 1 && candidate.source === "code") continue;
      if (mode === "wake" && level === 1 && candidate.source === "local_memory" && (counts.local_memory ?? 0) >= 2)
        continue;
      if (mode === "wake" && level === 1 && candidate.source === "git" && (counts.git ?? 0) >= 3) continue;
      counts[candidate.source] = (counts[candidate.source] ?? 0) + 1;
      if (candidate.source === "shared_memory") sharedCount += 1;
      selectedItems.push(candidate);
    }
    selected = selectedItems.sort((a, b) => b.fusedScore - a.fusedScore || Number(b.exactMatch) - Number(a.exactMatch));
    const sharedRemaining = { remaining: mode === "wake" && level === 1 ? 600 : Number.MAX_SAFE_INTEGER };
    const deliveredCandidates: RankedCandidate[] = [];
    const items = selected.flatMap((candidate) => {
      const item = itemFromCandidate(candidate, sharedRemaining);
      if (candidate.source === "shared_memory" && item.excerpt.length === 0) return [];
      deliveredCandidates.push(candidate);
      return [item];
    });
    const sharedBudgetOmitted = deliveredCandidates.length !== selected.length;
    selected = deliveredCandidates;
    const failuresBySource = new Map<ContextSource, ProviderFailure>(
      retrieval.degraded.map((failure) => [failure.provider, failure]),
    );
    const codeFailure = failuresBySource.get("code");
    const graphState =
      codeFailure?.code === "missing"
        ? "missing"
        : codeFailure
          ? "error"
          : checkoutChanged
            ? "pending"
            : (retrieval.codeGraph?.state ??
              (selected.some((item) => item.source === "code" && item.freshness === "stale")
                ? "pending"
                : plan.providers.includes("code")
                  ? "ready"
                  : "pending"));
    const freshness = {
      generatedAt: now().toISOString(),
      ...(project.head ? { gitHead: project.head } : {}),
      ...(project.branch ? { branch: project.branch } : {}),
      workingTree: project.workingTree,
      codeGraph: graphState,
      pendingFiles:
        retrieval.codeGraph?.pendingFiles ??
        selected.flatMap((item) =>
          item.provenance.flatMap((evidence) =>
            evidence.kind === "code" && evidence.graphState !== "ready" ? [evidence.path] : [],
          ),
        ),
      ...(selected.some((item) => item.source === "shared_memory") ? { sharedRetrievedAt: now().toISOString() } : {}),
    };
    const reasons = [
      ...(deduped.duplicates ? ["duplicate" as const] : []),
      ...(cursor.omitted ? ["already_delivered" as const] : []),
      ...(cursor.reset ? ["cursor_reset" as const] : []),
      ...(deduped.items.length > selected.length + cursor.omitted ? ["item_cap" as const] : []),
      ...(sharedBudgetOmitted ? ["provider_limit" as const] : []),
    ];
    const selectedIds = new Set(selected.map(({ id }) => id));
    const omittedCandidates = retrieval.candidates.filter((candidate) => !selectedIds.has(candidate.id));
    const packetId = newId("pkt_");
    const packet = ContextPacketSchema.parse({
      schemaVersion: 1,
      packetId,
      cursor: cursor.cursor,
      mode,
      request: {
        ...(mode === "wake" && request.input.task ? { task: request.input.task } : {}),
        ...(mode === "search"
          ? { query: request.input.query }
          : mode === "explain" && request.input.query
            ? { query: request.input.query }
            : {}),
        ...(mode === "wake" ? { requestedLevel: level } : {}),
        ...(requestMax !== undefined ? { requestedMaxTokens: requestMax } : {}),
        ...(remaining !== undefined ? { remainingContextTokens: remaining } : {}),
        effectiveMaxTokens: budget,
      },
      project,
      freshness,
      items,
      conflicts,
      degraded: retrieval.degraded,
      omitted: {
        candidates: omittedCandidates.length,
        estimatedTokens: Math.ceil(
          omittedCandidates.reduce((sum, candidate) => sum + codePoints(candidate.content), 0) / 3,
        ),
        reasons,
      },
      estimatedTokens: 0,
    });
    const format = "responseFormat" in rawInput ? (rawInput.responseFormat ?? "markdown") : "markdown";
    const mandatory = new Set([
      ...selected.filter((item) => item.exactMatch || isWarning(item)).map(({ id }) => id),
      ...conflicts.flatMap(({ itemIds }) => itemIds),
    ]);
    try {
      const fitted = fitContextPacket(packet, format, budget, mandatory);
      const hashes = new Map(selected.map(({ id, contentHash }) => [id, contentHash]));
      cursors.commit(
        cursor,
        fitted.items.flatMap(({ id }) => {
          const contentHash = hashes.get(id);
          return contentHash ? [{ id, contentHash }] : [];
        }),
      );
      return fitted;
    } catch (error) {
      if (error instanceof ContextBudgetError)
        throw new ContextEngineError("context_invalid", "The requested response budget is infeasible.");
      throw error;
    }
  };

  return {
    async wake(input, signal) {
      return run({ mode: "wake", input: BrainWakeInputSchema.parse(input) }, input, signal);
    },
    async search(input, signal) {
      return run({ mode: "search", input: BrainSearchInputSchema.parse(input) }, input, signal);
    },
    async explain(input, signal) {
      return run({ mode: "explain", input: BrainExplainInputSchema.parse(input) }, input, signal);
    },
    async status(input, signal) {
      if (signal?.aborted) throw signal.reason;
      const status = await brain.status(input.projectPath);
      const observed = (state: "ready" | "degraded" | "missing" | "not_requested", code?: ProviderFailure["code"]) => ({
        state,
        observedAt: now().toISOString(),
        ...(code ? { code } : {}),
      });
      const result = {
        schemaVersion: 1,
        project: status.project,
        providers: {
          local_memory: observed(
            status.memory.state === "ready" ? "ready" : status.memory.state === "missing" ? "missing" : "degraded",
          ),
          code: observed(
            status.codeGraph.state === "ready"
              ? "ready"
              : status.codeGraph.state === "missing"
                ? "missing"
                : "degraded",
          ),
          git: observed(status.git.state === "ready" ? "ready" : "degraded"),
          shared_memory: options.shared
            ? await options.shared
                .status(signal ?? new AbortController().signal)
                .then(({ state, observedAt }) => ({ state, observedAt }))
            : observed("not_requested"),
        },
        freshness: {
          generatedAt: now().toISOString(),
          ...(status.git.head ? { gitHead: status.git.head } : {}),
          ...(status.git.branch ? { branch: status.git.branch } : {}),
          ...(status.git.workingTree ? { workingTree: status.git.workingTree } : {}),
        },
        cursorCache: { entries: cursors.size, maxEntries: 128, ttlSeconds: 14_400 },
      };
      return BrainStatusResultSchema.parse(result);
    },
    close: () => brain.close(),
  };
};
