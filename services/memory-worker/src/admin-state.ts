import {
  ADMIN_EMBEDDING_PROFILE_ID,
  type AdminState,
  readAdminState as parseAdminState,
  REINDEX_LEASE_MS,
  REINDEX_MAX_ATTEMPTS,
  type ReindexEntry,
  type RunClaim,
  type RunDescriptor,
} from "../../../packages/memory-storage/src/state";
import { MemoryServiceError } from "./errors";

export {
  ADMIN_EMBEDDING_PROFILE_ID,
  type AdminState,
  REINDEX_LEASE_MS,
  REINDEX_MAX_ATTEMPTS,
  type ReindexClaim,
  type ReindexEntry,
  type RunClaim,
  type RunDescriptor,
} from "../../../packages/memory-storage/src/state";

function unavailable(): never {
  throw new MemoryServiceError("memory_unavailable", 503, true);
}

function ownValue<T>(dictionary: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

export function readAdminState(value: unknown): AdminState {
  try {
    return parseAdminState(value);
  } catch {
    return unavailable();
  }
}

function cloneState(value: unknown): AdminState {
  return structuredClone(readAdminState(value));
}

function finalized(run: RunDescriptor): boolean {
  return run.progress.completed + run.progress.failed === run.progress.claimed;
}

function markClaim(state: AdminState, runKey: string, id: string, token: string, status: "completed" | "failed"): void {
  const run = ownValue(state.reindex.runs, runKey);
  const claim = run?.claims.find(
    (candidate) => candidate.id === id && candidate.token === token && candidate.status === "claimed",
  );
  if (!run || !claim) return;
  claim.status = status;
  run.progress[status] += 1;
  run.finalized = finalized(run);
}

function recoverExpiredRuns(state: AdminState, now: Date): void {
  for (const [runKey, run] of Object.entries(state.reindex.runs)) {
    if (run.finalized || Date.parse(run.expiresAt) > now.getTime()) continue;
    for (const claim of run.claims) {
      if (claim.status !== "claimed") continue;
      const pending = state.reindex.pending.find(
        (entry) => entry.id === claim.id && entry.claim?.runKey === runKey && entry.claim.token === claim.token,
      );
      if (pending) delete pending.claim;
      markClaim(state, runKey, claim.id, claim.token, "failed");
    }
  }
}

export function enqueueReindex(
  input: unknown,
  records: Array<{ id: string; contentHash: string }>,
  operationKey: string,
): { state: AdminState; queued: number } {
  const state = cloneState(input);
  const next = new Map(state.reindex.pending.map((entry) => [entry.id, entry]));
  let queued = 0;
  for (const record of records) {
    if (!record.id || !record.contentHash) return unavailable();
    const existing = next.get(record.id);
    if (existing?.contentHash === record.contentHash) {
      if (existing.claim) continue;
      if (existing.attempts >= REINDEX_MAX_ATTEMPTS && state.reindex.lastOperationKey !== operationKey) {
        existing.attempts = 0;
        queued += 1;
      }
      continue;
    }
    if (existing?.claim) markClaim(state, existing.claim.runKey, existing.id, existing.claim.token, "failed");
    next.set(record.id, { id: record.id, contentHash: record.contentHash, attempts: 0 });
    queued += 1;
  }
  state.reindex.pending = [...next.values()];
  state.reindex.lastOperationKey = operationKey;
  return { state, queued };
}

export type StartRunResult =
  | { state: AdminState; kind: "started"; runKey: string; claimed: ReindexEntry[] }
  | {
      state: AdminState;
      kind: "recovered";
      runKey: string;
      operationId: string;
      claimed: number;
      completed: number;
      failed: number;
    };

export function startRun(
  input: unknown,
  args: {
    operationKey: string;
    requestHash: string;
    operationId: string;
    limit: number;
    now: Date;
    token: () => string;
  },
): StartRunResult {
  const state = cloneState(input);
  if (!Number.isFinite(args.now.getTime()) || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
    return unavailable();
  recoverExpiredRuns(state, args.now);
  const runKey = JSON.stringify(["operator", "configured-admin", args.operationKey]);
  const prior = ownValue(state.reindex.runs, runKey);
  if (prior) {
    if (prior.requestHash !== args.requestHash) throw new MemoryServiceError("operation_key_conflict", 409);
    if (prior.finalized) return { state, kind: "recovered", runKey, operationId: prior.operationId, ...prior.progress };
    if (Date.parse(prior.expiresAt) > args.now.getTime()) throw new MemoryServiceError("memory_unavailable", 503, true);
    return { state, kind: "recovered", runKey, operationId: prior.operationId, ...prior.progress };
  }

  const limit = args.limit;
  if (!args.requestHash || !args.operationId || !args.token) return unavailable();
  const expiresAt = new Date(args.now.getTime() + REINDEX_LEASE_MS).toISOString();
  const claimed: ReindexEntry[] = [];
  const runClaims: RunClaim[] = [];
  for (const entry of state.reindex.pending) {
    if (claimed.length >= limit) break;
    if (entry.claim || entry.attempts >= REINDEX_MAX_ATTEMPTS) continue;
    const token = args.token();
    if (!token || state.reindex.pending.some((item) => item !== entry && item.claim?.token === token))
      return unavailable();
    entry.attempts += 1;
    entry.claim = { token, expiresAt, runKey };
    claimed.push(structuredClone(entry));
    runClaims.push({ id: entry.id, contentHash: entry.contentHash, token, status: "claimed" });
  }
  state.reindex.runs[runKey] = {
    requestHash: args.requestHash,
    operationId: args.operationId,
    expiresAt,
    claims: runClaims,
    progress: { claimed: claimed.length, completed: 0, failed: 0 },
    finalized: claimed.length === 0,
  };
  return { state, kind: "started", runKey, claimed };
}

export function finishClaim(
  input: unknown,
  args: {
    runKey: string;
    id: string;
    token: string;
    contentHash: string;
    active: boolean;
    profileId: string;
    now: Date;
    succeeded: boolean;
  },
): { state: AdminState; accepted: boolean } {
  const state = cloneState(input);
  const entry = state.reindex.pending.find((candidate) => candidate.id === args.id);
  if (
    !entry ||
    entry.contentHash !== args.contentHash ||
    !entry.claim ||
    entry.claim.runKey !== args.runKey ||
    entry.claim.token !== args.token ||
    !Number.isFinite(args.now.getTime()) ||
    Date.parse(entry.claim.expiresAt) <= args.now.getTime() ||
    !args.active ||
    args.profileId !== ADMIN_EMBEDDING_PROFILE_ID
  )
    return { state, accepted: false };
  delete entry.claim;
  if (args.succeeded) state.reindex.pending = state.reindex.pending.filter((candidate) => candidate.id !== args.id);
  markClaim(state, args.runKey, args.id, args.token, args.succeeded ? "completed" : "failed");
  return { state, accepted: true };
}

/** Cancellation is durable and makes any worker holding the removed claim stale. */
export function cancelReindex(input: unknown, id: string): AdminState {
  const state = cloneState(input);
  const entries = state.reindex.pending.filter((entry) => entry.id === id);
  state.reindex.pending = state.reindex.pending.filter((entry) => entry.id !== id);
  for (const entry of entries) {
    if (entry.claim) markClaim(state, entry.claim.runKey, id, entry.claim.token, "failed");
  }
  return state;
}
