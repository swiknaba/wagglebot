import { expect, test } from "bun:test";
import {
  ADMIN_EMBEDDING_PROFILE_ID,
  cancelReindex,
  enqueueReindex,
  finishClaim,
  REINDEX_LEASE_MS,
  REINDEX_MAX_ATTEMPTS,
  readAdminState,
  startRun,
} from "./admin-state";

const empty = () => ({ operations: {}, sources: {}, reindex: { pending: [] } });
const start = (state: unknown, key: string, now: Date, limit = 10) =>
  startRun(state, {
    operationKey: key,
    requestHash: `hash:${key}`,
    operationId: `id:${key}`,
    limit,
    now,
    token: (() => {
      let index = 0;
      return () => `token-${key}-${++index}`;
    })(),
  });

function firstClaim(
  entries: Array<{
    id: string;
    contentHash: string;
    attempts: number;
    claim?: { token: string; expiresAt: string; runKey: string };
  }>,
) {
  const entry = entries[0];
  if (!entry?.claim) throw new Error("expected a claimed reindex entry");
  return { entry, claim: entry.claim };
}

test("state initializes runs only when absent and rejects malformed persisted state safely", () => {
  const initialized = readAdminState(empty());
  expect(initialized.reindex.runs).toEqual({});
  expect((empty().reindex as { runs?: unknown }).runs).toBeUndefined();
  expect(() => readAdminState({ operations: {}, reindex: { pending: [], runs: [] } })).toThrow(
    expect.objectContaining({ code: "memory_unavailable", retryable: true }),
  );
  expect(() =>
    readAdminState({ operations: {}, reindex: { pending: [{ id: "x", contentHash: "h", attempts: 4 }] } }),
  ).toThrow(expect.objectContaining({ code: "memory_unavailable" }));
  expect(() =>
    readAdminState({
      operations: {},
      reindex: {
        pending: [
          { id: "x", contentHash: "h", attempts: 0 },
          { id: "x", contentHash: "h", attempts: 0 },
        ],
      },
    }),
  ).toThrow(expect.objectContaining({ code: "memory_unavailable" }));

  const activeRun = start(
    enqueueReindex(empty(), [{ id: "active", contentHash: "hash" }], "queue").state,
    "active-run",
    new Date("2026-01-01T00:00:00Z"),
  );
  if (activeRun.kind !== "started") throw new Error("expected started run");
  const activeRunKey = Object.keys(activeRun.state.reindex.runs)[0];
  if (!activeRunKey) throw new Error("expected run descriptor");
  const mismatchedRun = structuredClone(activeRun.state);
  const activeDescriptor = mismatchedRun.reindex.runs[activeRunKey];
  const activeRunClaim = activeDescriptor?.claims[0];
  if (!activeRunClaim) throw new Error("expected run claim");
  activeRunClaim.token = "mismatched-token";
  expect(() => readAdminState(mismatchedRun)).toThrow(expect.objectContaining({ code: "memory_unavailable" }));

  const inheritedRuns = Object.create({
    inherited: {
      requestHash: "h",
      operationId: "id",
      expiresAt: "2026-01-01T00:00:00Z",
      claims: [],
      progress: { claimed: 0, completed: 0, failed: 0 },
      finalized: true,
    },
  });
  expect(() =>
    readAdminState({
      operations: {},
      reindex: {
        pending: [
          {
            id: "x",
            contentHash: "h",
            attempts: 1,
            claim: { token: "t", expiresAt: "2026-01-01T00:00:00Z", runKey: "inherited" },
          },
        ],
        runs: inheritedRuns,
      },
    }),
  ).toThrow(expect.objectContaining({ code: "memory_unavailable" }));
});

test("reindex deduplicates, preserves valid claims, and resets exhausted work for a new key", () => {
  const queued = enqueueReindex(
    empty(),
    [
      { id: "a", contentHash: "h1" },
      { id: "a", contentHash: "h1" },
    ],
    "first",
  );
  expect(queued.queued).toBe(1);
  const claimed = start(queued.state, "run", new Date("2026-01-01T00:00:00Z"));
  expect(claimed.kind).toBe("started");
  if (claimed.kind !== "started") return;
  const duplicate = enqueueReindex(claimed.state, [{ id: "a", contentHash: "h1" }], "second");
  expect(duplicate.state.reindex.pending[0]?.claim?.token).toBe("token-run-1");
  const changedHash = enqueueReindex(duplicate.state, [{ id: "a", contentHash: "h2" }], "third");
  expect(changedHash.state.reindex.pending[0]).toEqual({ id: "a", contentHash: "h2", attempts: 0 });
  const exhausted = {
    ...empty(),
    reindex: {
      pending: [{ id: "x", contentHash: "hx", attempts: REINDEX_MAX_ATTEMPTS }],
      runs: {},
      lastOperationKey: "prior",
    },
  };
  const reset = enqueueReindex(exhausted, [{ id: "x", contentHash: "hx" }], "new-key");
  expect(reset.state.reindex.pending[0]?.attempts).toBe(0);
});

test("claim leases fence concurrent drains and same-key retries recover after expiry", () => {
  const queued = enqueueReindex(
    empty(),
    [
      { id: "a", contentHash: "h" },
      { id: "b", contentHash: "h" },
    ],
    "queue",
  );
  const now = new Date("2026-01-01T00:00:00Z");
  const first = start(queued.state, "run-one", now, 1);
  expect(first.kind).toBe("started");
  if (first.kind !== "started") return;
  expect(first.claimed).toHaveLength(1);
  const firstClaimed = firstClaim(first.claimed);
  expect(Date.parse(firstClaimed.claim.expiresAt) - now.getTime()).toBe(REINDEX_LEASE_MS);
  const concurrent = start(first.state, "run-two", now, 10);
  expect(concurrent.kind).toBe("started");
  if (concurrent.kind === "started") expect(concurrent.claimed.map((entry) => entry.id)).toEqual(["b"]);
  expect(() => start(first.state, "run-one", now, 1)).toThrow(
    expect.objectContaining({ code: "memory_unavailable", retryable: true }),
  );
  const leased = firstClaim(first.claimed);
  expect(
    finishClaim(first.state, {
      runKey: first.runKey,
      id: leased.entry.id,
      token: leased.claim.token,
      contentHash: leased.entry.contentHash,
      active: true,
      profileId: ADMIN_EMBEDDING_PROFILE_ID,
      now: new Date(now.getTime() + REINDEX_LEASE_MS),
      succeeded: true,
    }).accepted,
  ).toBe(false);

  const recovered = start(first.state, "run-one", new Date(now.getTime() + REINDEX_LEASE_MS), 1);
  expect(recovered).toMatchObject({ kind: "recovered", claimed: 1, completed: 0, failed: 1 });
  if (recovered.kind === "recovered") expect(recovered.state.reindex.pending[0]?.claim).toBeUndefined();
  expect(() =>
    startRun(first.state, {
      operationKey: "run-one",
      requestHash: "different-hash",
      operationId: "id:run-one",
      limit: 1,
      now: new Date(now.getTime() + REINDEX_LEASE_MS),
      token: () => "unused",
    }),
  ).toThrow(expect.objectContaining({ code: "operation_key_conflict" }));
});

test("a new run key recovers an abandoned run before draining its eligible work", () => {
  const queued = enqueueReindex(
    empty(),
    [
      { id: "a", contentHash: "ha" },
      { id: "b", contentHash: "hb" },
    ],
    "queue",
  );
  const startedAt = new Date("2026-02-01T00:00:00Z");
  const abandoned = start(queued.state, "abandoned", startedAt);
  if (abandoned.kind !== "started") throw new Error("expected started run");
  const [first, second] = abandoned.claimed;
  if (!first || !second?.claim || !first.claim) throw new Error("expected two leased entries");
  const partiallyCompleted = finishClaim(abandoned.state, {
    runKey: abandoned.runKey,
    id: first.id,
    token: first.claim.token,
    contentHash: first.contentHash,
    active: true,
    profileId: ADMIN_EMBEDDING_PROFILE_ID,
    now: new Date(startedAt.getTime() + 1_000),
    succeeded: true,
  });
  expect(partiallyCompleted.accepted).toBe(true);

  const recoveredAndDrained = start(
    partiallyCompleted.state,
    "new-operation",
    new Date(startedAt.getTime() + REINDEX_LEASE_MS),
  );
  expect(recoveredAndDrained.kind).toBe("started");
  if (recoveredAndDrained.kind !== "started") return;
  expect(recoveredAndDrained.claimed.map((entry) => entry.id)).toEqual(["b"]);
  expect(recoveredAndDrained.claimed[0]?.attempts).toBe(2);
  expect(recoveredAndDrained.claimed[0]?.claim?.token).not.toBe(second.claim.token);

  const sameKeyRetry = start(
    recoveredAndDrained.state,
    "abandoned",
    new Date(startedAt.getTime() + REINDEX_LEASE_MS + 1),
  );
  expect(sameKeyRetry).toMatchObject({ kind: "recovered", claimed: 2, completed: 1, failed: 1 });
  expect(
    finishClaim(recoveredAndDrained.state, {
      runKey: abandoned.runKey,
      id: second.id,
      token: second.claim.token,
      contentHash: second.contentHash,
      active: true,
      profileId: ADMIN_EMBEDDING_PROFILE_ID,
      now: new Date(startedAt.getTime() + REINDEX_LEASE_MS + 1),
      succeeded: true,
    }).accepted,
  ).toBe(false);
});

test("reindex preserves an exhausted in-flight claim instead of resetting its attempt count", () => {
  let state: unknown = enqueueReindex(empty(), [{ id: "a", contentHash: "h" }], "queue").state;
  for (let attempt = 1; attempt < REINDEX_MAX_ATTEMPTS; attempt += 1) {
    const run = start(state, `failed-${attempt}`, new Date(`2026-03-0${attempt}T00:00:00Z`));
    if (run.kind !== "started") throw new Error("expected started run");
    const { entry, claim } = firstClaim(run.claimed);
    state = finishClaim(run.state, {
      runKey: run.runKey,
      id: entry.id,
      token: claim.token,
      contentHash: entry.contentHash,
      active: true,
      profileId: ADMIN_EMBEDDING_PROFILE_ID,
      now: new Date(`2026-03-0${attempt}T00:00:01Z`),
      succeeded: false,
    }).state;
  }
  const thirdAttempt = start(state, "third-attempt", new Date("2026-03-03T00:00:00Z"));
  if (thirdAttempt.kind !== "started") throw new Error("expected started run");
  const active = firstClaim(thirdAttempt.claimed);
  expect(active.entry.attempts).toBe(REINDEX_MAX_ATTEMPTS);

  const reindexed = enqueueReindex(thirdAttempt.state, [{ id: "a", contentHash: "h" }], "new-key");
  expect(reindexed.queued).toBe(0);
  expect(reindexed.state.reindex.pending[0]).toEqual(active.entry);
});

test("attempt count is bounded and stale tokens, changed hashes, inactive rows, or wrong profiles cannot commit", () => {
  let state: unknown = enqueueReindex(empty(), [{ id: "a", contentHash: "h" }], "queue").state;
  for (let attempt = 1; attempt <= REINDEX_MAX_ATTEMPTS; attempt += 1) {
    const run = start(state, `run-${attempt}`, new Date(`2026-01-0${attempt}T00:00:00Z`));
    expect(run.kind).toBe("started");
    if (run.kind !== "started") return;
    const { entry, claim } = firstClaim(run.claimed);
    const failed = finishClaim(run.state, {
      runKey: run.runKey,
      id: entry.id,
      token: claim.token,
      contentHash: entry.contentHash,
      active: true,
      profileId: ADMIN_EMBEDDING_PROFILE_ID,
      now: new Date("2026-01-01T00:00:00Z"),
      succeeded: false,
    });
    expect(failed.accepted).toBe(true);
    state = failed.state;
  }
  const capped = start(state, "run-capped", new Date("2026-01-05T00:00:00Z"));
  expect(capped.kind).toBe("started");
  if (capped.kind === "started") expect(capped.claimed).toHaveLength(0);

  const fresh = start(
    enqueueReindex(empty(), [{ id: "z", contentHash: "hz" }], "q").state,
    "run-z",
    new Date("2026-01-06T00:00:00Z"),
  );
  if (fresh.kind !== "started") throw new Error("expected started run");
  const { claim } = firstClaim(fresh.claimed);
  for (const invalid of [
    { token: "old-token", contentHash: "hz", active: true, profileId: ADMIN_EMBEDDING_PROFILE_ID },
    { token: claim.token, contentHash: "changed", active: true, profileId: ADMIN_EMBEDDING_PROFILE_ID },
    { token: claim.token, contentHash: "hz", active: false, profileId: ADMIN_EMBEDDING_PROFILE_ID },
    { token: claim.token, contentHash: "hz", active: true, profileId: "wrong" },
  ]) {
    expect(
      finishClaim(fresh.state, {
        runKey: fresh.runKey,
        id: "z",
        ...invalid,
        now: new Date("2026-01-06T00:00:00Z"),
        succeeded: true,
      }).accepted,
    ).toBe(false);
  }
});

test("successful claim progress persists, while invalidation cancels work and fences its worker", () => {
  const queued = enqueueReindex(empty(), [{ id: "a", contentHash: "h" }], "queue");
  const run = start(queued.state, "run", new Date("2026-01-01T00:00:00Z"));
  if (run.kind !== "started") throw new Error("expected started run");
  const { entry, claim } = firstClaim(run.claimed);
  const committed = finishClaim(run.state, {
    runKey: run.runKey,
    id: entry.id,
    token: claim.token,
    contentHash: entry.contentHash,
    active: true,
    profileId: ADMIN_EMBEDDING_PROFILE_ID,
    now: new Date("2026-01-01T00:00:01Z"),
    succeeded: true,
  });
  expect(committed.accepted).toBe(true);
  expect(committed.state.reindex.pending).toHaveLength(0);
  expect(committed.state.reindex.runs[run.runKey]?.progress).toEqual({ claimed: 1, completed: 1, failed: 0 });

  const second = start(queued.state, "run-two", new Date("2026-01-02T00:00:00Z"));
  if (second.kind !== "started") throw new Error("expected started run");
  const canceledClaim = firstClaim(second.claimed);
  const canceled = cancelReindex(second.state, "a");
  expect(canceled.reindex.pending).toHaveLength(0);
  expect(canceled.reindex.runs[second.runKey]?.progress.failed).toBe(1);
  expect(
    finishClaim(canceled, {
      runKey: second.runKey,
      id: "a",
      token: canceledClaim.claim.token,
      contentHash: "h",
      active: true,
      profileId: ADMIN_EMBEDDING_PROFILE_ID,
      now: new Date("2026-01-02T00:00:01Z"),
      succeeded: true,
    }).accepted,
  ).toBe(false);
});
