import { type SharedScope, SharedScopeSchema } from "../../contracts/src/base";

export const ADMIN_EMBEDDING_PROFILE_ID = "7101cc0e-6a04-503b-8d23-329b99cff42f";
export const REINDEX_LEASE_MS = 5 * 60 * 1000;
export const REINDEX_MAX_ATTEMPTS = 3;

export type ReindexClaim = { token: string; expiresAt: string; runKey: string };
export type ReindexEntry = { id: string; contentHash: string; attempts: number; claim?: ReindexClaim };
export type RunClaim = { id: string; contentHash: string; token: string; status: "claimed" | "completed" | "failed" };
export type RunDescriptor = {
  requestHash: string;
  operationId: string;
  expiresAt: string;
  claims: RunClaim[];
  progress: { claimed: number; completed: number; failed: number };
  finalized: boolean;
};
export type AdminState = {
  [key: string]: unknown;
  operations: Record<string, unknown>;
  reindex: {
    [key: string]: unknown;
    pending: ReindexEntry[];
    runs: Record<string, RunDescriptor>;
    lastOperationKey?: string;
  };
};

function unavailable(): never {
  throw new Error("invalid_memory_state");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue<T>(dictionary: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

function validClaim(value: unknown): value is ReindexClaim {
  if (!isObject(value)) return false;
  return (
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.runKey === "string" &&
    value.runKey.length > 0
  );
}

function validEntry(value: unknown): value is ReindexEntry {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.contentHash !== "string" ||
    !value.contentHash ||
    !Number.isInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    Number(value.attempts) > REINDEX_MAX_ATTEMPTS
  )
    return false;
  return value.claim === undefined || validClaim(value.claim);
}

function validRun(value: unknown): value is RunDescriptor {
  if (
    !isObject(value) ||
    typeof value.requestHash !== "string" ||
    !value.requestHash ||
    typeof value.operationId !== "string" ||
    !value.operationId ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.claims) ||
    !isObject(value.progress) ||
    typeof value.finalized !== "boolean"
  )
    return false;
  if (
    !Number.isInteger(value.progress.claimed) ||
    !Number.isInteger(value.progress.completed) ||
    !Number.isInteger(value.progress.failed) ||
    Number(value.progress.claimed) < 0 ||
    Number(value.progress.completed) < 0 ||
    Number(value.progress.failed) < 0
  )
    return false;
  if (
    !value.claims.every(
      (claim) =>
        isObject(claim) &&
        typeof claim.id === "string" &&
        claim.id.length > 0 &&
        typeof claim.contentHash === "string" &&
        claim.contentHash.length > 0 &&
        typeof claim.token === "string" &&
        claim.token.length > 0 &&
        ["claimed", "completed", "failed"].includes(String(claim.status)),
    )
  )
    return false;
  const completed = value.claims.filter((claim) => isObject(claim) && claim.status === "completed").length;
  const failed = value.claims.filter((claim) => isObject(claim) && claim.status === "failed").length;
  const claimed = value.claims.length;
  return (
    value.progress.claimed === claimed &&
    value.progress.completed === completed &&
    value.progress.failed === failed &&
    value.finalized === (completed + failed === claimed)
  );
}

/** Validate persisted worker state; only the runs dictionary may be initialized when absent. */
export function readAdminState(value: unknown): AdminState {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return unavailable();
    }
  }
  if (
    !isObject(value) ||
    !isObject(value.operations) ||
    !isObject(value.reindex) ||
    !Array.isArray(value.reindex.pending)
  )
    return unavailable();
  if (!value.reindex.pending.every(validEntry)) return unavailable();
  const pendingIds = new Set<string>();
  for (const entry of value.reindex.pending as ReindexEntry[]) {
    if (pendingIds.has(entry.id)) return unavailable();
    pendingIds.add(entry.id);
  }
  const rawRuns = value.reindex.runs;
  if (rawRuns !== undefined && (!isObject(rawRuns) || !Object.values(rawRuns).every(validRun))) return unavailable();
  const runs = (rawRuns ?? {}) as Record<string, RunDescriptor>;
  const claimTokens = new Set<string>();
  for (const run of Object.values(runs)) {
    const claimIds = new Set<string>();
    for (const claim of run.claims) {
      if (claimIds.has(claim.id) || claimTokens.has(claim.token)) return unavailable();
      claimIds.add(claim.id);
      claimTokens.add(claim.token);
    }
  }
  for (const entry of value.reindex.pending as ReindexEntry[]) {
    if (!entry.claim) continue;
    const run = ownValue(runs, entry.claim.runKey);
    const claim = run?.claims.find((candidate) => candidate.id === entry.id && candidate.token === entry.claim?.token);
    if (!claim || claim.status !== "claimed" || claim.contentHash !== entry.contentHash) return unavailable();
  }
  for (const [runKey, run] of Object.entries(runs)) {
    for (const claim of run.claims) {
      if (claim.status !== "claimed") continue;
      const entry = (value.reindex.pending as ReindexEntry[]).find(
        (candidate) => candidate.id === claim.id && candidate.claim?.token === claim.token,
      );
      if (!entry || entry.contentHash !== claim.contentHash || entry.claim?.runKey !== runKey) return unavailable();
    }
  }
  return {
    ...value,
    reindex: { ...value.reindex, runs },
  } as AdminState;
}

export type SourceState = {
  repository: string;
  path: string;
  scope: SharedScope;
  owner: string;
  currentRevision: string;
  bodyHash: string;
  revisions: string[];
  chunks: Record<string, string>;
};

export function readSourceState(value: unknown): SourceState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) unavailable();
  const record = value as Record<string, unknown>;
  const scope = SharedScopeSchema.safeParse(record.scope);
  if (
    typeof record.repository !== "string" ||
    typeof record.path !== "string" ||
    typeof record.owner !== "string" ||
    typeof record.currentRevision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(record.currentRevision) ||
    typeof record.bodyHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.bodyHash) ||
    !Array.isArray(record.revisions) ||
    !record.revisions.every((revision) => typeof revision === "string" && /^[a-f0-9]{40}$/u.test(revision)) ||
    !record.revisions.includes(record.currentRevision) ||
    !scope.success ||
    typeof record.chunks !== "object" ||
    record.chunks === null ||
    Array.isArray(record.chunks)
  ) {
    unavailable();
  }
  const chunks = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record.chunks)) chunks[key] = (record.chunks as Record<string, unknown>)[key];
  const revisions = record.revisions as string[];
  if (new Set(revisions).size !== revisions.length || revisions.at(-1) !== record.currentRevision) unavailable();
  for (const [key, id] of Object.entries(chunks)) {
    if (key.length === 0 || typeof id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(id))
      unavailable();
  }
  return {
    repository: record.repository,
    path: record.path,
    scope: scope.data,
    owner: record.owner,
    currentRevision: record.currentRevision,
    bodyHash: record.bodyHash,
    revisions: [...revisions],
    chunks: chunks as Record<string, string>,
  };
}
