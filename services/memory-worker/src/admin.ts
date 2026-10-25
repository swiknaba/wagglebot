import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type AdminReindexRequest,
  AdminReindexRequestSchema,
  AdminReindexResponseSchema,
  type AdminRescanRequest,
  AdminRescanRequestSchema,
  AdminRescanResponseSchema,
  AdminRunOnceRequestSchema,
  AdminRunOnceResponseSchema,
} from "../../../packages/contracts/src/memory";
import {
  ADMIN_EMBEDDING_PROFILE_ID,
  type AdminState,
  cancelReindex,
  enqueueReindex,
  finishClaim,
  type ReindexEntry,
  readAdminState,
  startRun,
} from "./admin-state";
import { EMBEDDING_PROFILE } from "./config";
import type { EmbeddingProvider } from "./embeddings";
import { decodeMemoryRecord } from "./record-mapping";
import type { MemoryRepository, MemoryTransaction } from "./repository";
import {
  actorKey,
  canonicalJson,
  MemoryServiceError,
  readOperationResult,
  readOperations,
  replayResult,
  withMutationState,
} from "./write-service";

type ScanFinding = { ruleId: string };
type AdminScanner = {
  scanPersistedDTO(value: unknown): Promise<{ findings: ScanFinding[]; count: number }>;
};

function requestHash(operation: string, request: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation,
        ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== "operationKey")),
      }),
    )
    .digest("hex");
}

function adminState(value: Record<string, unknown>): AdminState {
  return readAdminState(value);
}

function storeState(target: Record<string, unknown>, source: AdminState): void {
  target.reindex = source.reindex;
}

function rejectRunKeyConflict(state: Record<string, unknown>, key: string, hash: string): void {
  const runs = adminState(state).reindex.runs;
  const run = Object.hasOwn(runs, key) ? runs[key] : undefined;
  if (run && run.requestHash !== hash) throw new MemoryServiceError("operation_key_conflict", 409);
}

function safeScanFailure(error: unknown): never {
  if (error instanceof MemoryServiceError) throw error;
  throw new MemoryServiceError("scanner_unavailable", 503, true);
}

async function scanOperationKey(scanner: AdminScanner, operationKey: string): Promise<void> {
  try {
    const result = await scanner.scanPersistedDTO({ operationKey });
    if (!Number.isSafeInteger(result.count) || result.count < 0)
      throw new MemoryServiceError("scanner_unavailable", 503, true);
    if (result.count > 0) throw new MemoryServiceError("secret_rejected", 422);
  } catch (error) {
    safeScanFailure(error);
  }
}

function vectorText(vector: readonly number[]): string {
  if (vector.length !== 384 || vector.some((value) => !Number.isFinite(value)))
    throw new MemoryServiceError("provider_unavailable", 503, true);
  return `[${vector.join(",")}]`;
}

function cancellationIsStillOwned(state: AdminState, entry: ReindexEntry, runKey: string, token: string): boolean {
  return state.reindex.pending.some(
    (candidate) =>
      candidate.id === entry.id &&
      candidate.contentHash === entry.contentHash &&
      candidate.claim?.runKey === runKey &&
      candidate.claim.token === token,
  );
}

async function currentRecord(tx: MemoryTransaction, id: string) {
  const row = (await tx.query("SELECT * FROM wagglebot_memories WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!row) return undefined;
  return decodeMemoryRecord(row);
}

async function reindexResponse(repository: MemoryRepository, scanner: AdminScanner, request: AdminReindexRequest) {
  const key = actorKey("operator", "configured-admin", request.operationKey);
  const hash = requestHash("reindex", request);
  const prior = await readOperationResult(repository, key, hash, AdminReindexResponseSchema);
  if (prior) return prior;
  await scanOperationKey(scanner, request.operationKey);
  return withMutationState(repository, async (tx, state) => {
    const operations = readOperations(state);
    const replay = replayResult(operations, key, hash, AdminReindexResponseSchema);
    if (replay) return replay;
    rejectRunKeyConflict(state, key, hash);
    const rows = (await tx.query("SELECT * FROM wagglebot_memories WHERE active = true ORDER BY id")).rows;
    const records = rows.map(decodeMemoryRecord);
    const result = enqueueReindex(
      adminState(state),
      records.map((record) => ({ id: record.id, contentHash: record.contentHash })),
      request.operationKey,
    );
    storeState(state, result.state);
    const response = AdminReindexResponseSchema.parse({
      schemaVersion: 1,
      operationKey: request.operationKey,
      operationId: randomUUID(),
      queued: result.queued,
    });
    operations[key] = { requestHash: hash, result: response };
    state.operations = operations;
    return response;
  });
}

type ScannedRecord = { id: string; contentHash: string; fingerprint: string; rejected: boolean; ruleIds: string[] };
class RescanChangedError extends Error {}

async function scanRecords(repository: MemoryRepository, scanner: AdminScanner): Promise<ScannedRecord[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await repository.query("SELECT * FROM wagglebot_memories ORDER BY id");
  } catch {
    throw new MemoryServiceError("memory_unavailable", 503, true);
  }
  const scanned: ScannedRecord[] = [];
  for (const row of rows) {
    let record: ReturnType<typeof decodeMemoryRecord>;
    try {
      record = decodeMemoryRecord(row);
      const scan = await scanner.scanPersistedDTO(record);
      scanned.push({
        id: record.id,
        contentHash: record.contentHash,
        fingerprint: createHash("sha256").update(canonicalJson(record), "utf8").digest("hex"),
        rejected: scan.count > 0,
        ruleIds: [...new Set(scan.findings.map((finding) => finding.ruleId))].sort(),
      });
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      safeScanFailure(error);
    }
  }
  return scanned;
}

async function rescanResponse(
  repository: MemoryRepository,
  scanner: AdminScanner,
  request: AdminRescanRequest,
  now: () => Date,
) {
  const key = actorKey("operator", "configured-admin", request.operationKey);
  const hash = requestHash("rescan", request);
  const prior = await readOperationResult(repository, key, hash, AdminRescanResponseSchema);
  if (prior) return prior;
  await scanOperationKey(scanner, request.operationKey);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scanned = await scanRecords(repository, scanner);
    try {
      return await withMutationState(repository, async (tx, state) => {
        const operations = readOperations(state);
        const replay = replayResult(operations, key, hash, AdminRescanResponseSchema);
        if (replay) return replay;
        rejectRunKeyConflict(state, key, hash);
        const rows = (await tx.query("SELECT * FROM wagglebot_memories ORDER BY id")).rows;
        const current = rows.map((row) => {
          const record = decodeMemoryRecord(row);
          return {
            record,
            fingerprint: createHash("sha256").update(canonicalJson(record), "utf8").digest("hex"),
          };
        });
        if (
          current.length !== scanned.length ||
          current.some(
            (item, index) => item.record.id !== scanned[index]?.id || item.fingerprint !== scanned[index]?.fingerprint,
          )
        )
          throw new RescanChangedError();

        const at = now().toISOString();
        let invalidated = 0;
        const ruleIds = new Set<string>();
        let updatedState = adminState(state);
        for (let index = 0; index < current.length; index += 1) {
          const scannedRecord = scanned[index];
          const item = current[index];
          if (!item) continue;
          const { record } = item;
          if (!scannedRecord?.rejected || record.status !== "active") continue;
          await tx.query(
            "UPDATE wagglebot_memories SET active = false, invalidated_at = $2, invalidation_reason = $3, wake = false, updated_at = $2 WHERE id = $1 AND active = true",
            [record.id, at, "rejected by administrator rescan"],
          );
          updatedState = cancelReindex(updatedState, record.id);
          storeState(state, updatedState);
          for (const id of scannedRecord.ruleIds) ruleIds.add(id);
          invalidated += 1;
        }
        const response = AdminRescanResponseSchema.parse({
          schemaVersion: 1,
          operationKey: request.operationKey,
          operationId: randomUUID(),
          scanned: scanned.length,
          invalidated,
          ruleIds: [...ruleIds].sort(),
        });
        operations[key] = { requestHash: hash, result: response };
        state.operations = operations;
        return response;
      });
    } catch (error) {
      if (error instanceof RescanChangedError) continue;
      throw error;
    }
  }
  throw new MemoryServiceError("memory_unavailable", 503, true);
}

export function createAdminService(dependencies: {
  repository: MemoryRepository;
  scanner: AdminScanner;
  embeddingProvider: EmbeddingProvider;
  clock?: () => Date;
  token?: () => string;
  operationId?: () => string;
}) {
  const now = dependencies.clock ?? (() => new Date());
  const token = dependencies.token ?? (() => randomBytes(24).toString("base64url"));
  const operationId = dependencies.operationId ?? randomUUID;

  return {
    async rescan(raw: unknown) {
      const request = AdminRescanRequestSchema.parse(raw);
      return rescanResponse(dependencies.repository, dependencies.scanner, request, now);
    },

    async reindex(raw: unknown) {
      const request = AdminReindexRequestSchema.parse(raw);
      if (request.profileId !== undefined && request.profileId !== ADMIN_EMBEDDING_PROFILE_ID)
        throw new MemoryServiceError("embedding_profile_invalid", 400);
      return reindexResponse(dependencies.repository, dependencies.scanner, request);
    },

    async runOnce(raw: unknown) {
      const request = AdminRunOnceRequestSchema.parse(raw);
      const key = actorKey("operator", "configured-admin", request.operationKey);
      const hash = requestHash("run-once", request);
      const prior = await readOperationResult(dependencies.repository, key, hash, AdminRunOnceResponseSchema);
      if (prior) return prior;
      await scanOperationKey(dependencies.scanner, request.operationKey);

      const started = await withMutationState(dependencies.repository, async (_tx, state) => {
        const operations = readOperations(state);
        const replay = replayResult(operations, key, hash, AdminRunOnceResponseSchema);
        if (replay) return { replay };
        const transition = startRun(adminState(state), {
          operationKey: request.operationKey,
          requestHash: hash,
          operationId: operationId(),
          limit: request.limit,
          now: now(),
          token,
        });
        storeState(state, transition.state);
        return { transition };
      });
      if ("replay" in started) return started.replay;
      const transition = started.transition;
      if (transition.kind === "recovered") {
        return withMutationState(dependencies.repository, async (_tx, state) => {
          const operations = readOperations(state);
          const replay = replayResult(operations, key, hash, AdminRunOnceResponseSchema);
          if (replay) return replay;
          const response = AdminRunOnceResponseSchema.parse({
            schemaVersion: 1,
            operationKey: request.operationKey,
            operationId: transition.operationId,
            claimed: transition.claimed,
            completed: transition.completed,
            failed: transition.failed,
          });
          operations[key] = { requestHash: hash, result: response };
          state.operations = operations;
          return response;
        });
      }

      const { runKey, claimed } = transition;
      for (const entry of claimed) {
        const claim = entry.claim;
        if (!claim) continue;
        let embedding: number[] | undefined;
        let embeddingInput: string | undefined;
        let initialActive = false;
        try {
          const rows = await dependencies.repository.query("SELECT * FROM wagglebot_memories WHERE id = $1", [
            entry.id,
          ]);
          const row = rows[0];
          if (row) {
            const record = decodeMemoryRecord(row);
            initialActive = record.status === "active" && record.contentHash === entry.contentHash;
            if (initialActive) {
              embeddingInput = `${record.title}\n${record.content}`;
              embedding = await dependencies.embeddingProvider.embed(embeddingInput);
            }
          }
        } catch {
          embedding = undefined;
        }

        await withMutationState(dependencies.repository, async (tx, state) => {
          const current = await currentRecord(tx, entry.id);
          const active = current?.status === "active" && current.contentHash === entry.contentHash;
          const profileRows = await tx.query(
            "SELECT provider, model, dimension, distance, schema_version FROM wagglebot_memory_schema_metadata ORDER BY provider",
          );
          const databaseProfile = profileRows.rows[0];
          const profileMatches =
            profileRows.rows.length === 1 &&
            databaseProfile?.provider === EMBEDDING_PROFILE.provider &&
            databaseProfile?.model === EMBEDDING_PROFILE.model &&
            databaseProfile?.dimension === EMBEDDING_PROFILE.dimension &&
            databaseProfile?.distance === EMBEDDING_PROFILE.distance &&
            databaseProfile?.schema_version === 1;
          const next = adminState(state);
          if (!active || !profileMatches) {
            if (cancellationIsStillOwned(next, entry, runKey, claim.token))
              storeState(state, cancelReindex(next, entry.id));
            return;
          }
          if (embedding === undefined || embeddingInput !== `${current?.title}\n${current?.content}`) {
            const failed = finishClaim(next, {
              runKey,
              id: entry.id,
              token: claim.token,
              contentHash: entry.contentHash,
              active: true,
              profileId: ADMIN_EMBEDDING_PROFILE_ID,
              now: now(),
              succeeded: false,
            });
            if (failed.accepted) storeState(state, failed.state);
            return;
          }
          let vector: string;
          try {
            vector = vectorText(embedding);
          } catch {
            const failed = finishClaim(next, {
              runKey,
              id: entry.id,
              token: claim.token,
              contentHash: entry.contentHash,
              active: true,
              profileId: ADMIN_EMBEDDING_PROFILE_ID,
              now: now(),
              succeeded: false,
            });
            if (failed.accepted) storeState(state, failed.state);
            return;
          }
          const completed = finishClaim(next, {
            runKey,
            id: entry.id,
            token: claim.token,
            contentHash: entry.contentHash,
            active: true,
            profileId: ADMIN_EMBEDDING_PROFILE_ID,
            now: now(),
            succeeded: true,
          });
          if (!completed.accepted) return;
          await tx.query("UPDATE wagglebot_memories SET embedding = $2::vector, updated_at = $3 WHERE id = $1", [
            entry.id,
            vector,
            now().toISOString(),
          ]);
          storeState(state, completed.state);
        });
      }

      return withMutationState(dependencies.repository, async (_tx, state) => {
        const operations = readOperations(state);
        const replay = replayResult(operations, key, hash, AdminRunOnceResponseSchema);
        if (replay) return replay;
        const descriptor = adminState(state).reindex.runs[runKey];
        if (!descriptor || !descriptor.finalized) throw new MemoryServiceError("memory_unavailable", 503, true);
        const response = AdminRunOnceResponseSchema.parse({
          schemaVersion: 1,
          operationKey: request.operationKey,
          operationId: descriptor.operationId,
          ...descriptor.progress,
        });
        operations[key] = { requestHash: hash, result: response };
        state.operations = operations;
        return response;
      });
    },
  };
}
