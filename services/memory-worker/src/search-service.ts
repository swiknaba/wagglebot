import type { Catalog } from "../../../packages/company-config/src/catalog";
import type { SharedScope } from "../../../packages/contracts/src/base";
import {
  type GetMemoryResponse,
  GetMemoryResponseSchema,
  type MemorySearchInput,
  MemorySearchInputSchema,
  type MemorySearchResult,
  MemorySearchResultSchema,
} from "../../../packages/contracts/src/memory";
import type { EmbeddingProvider } from "./embeddings";
import type { Principal } from "./principal";
import { decodeMemoryRecord } from "./record-mapping";
import type { MemoryRepository } from "./repository";
import { MemoryPolicyError, validateSharedScope } from "./scopes";
import { MemoryServiceError } from "./write-service";

const DISTANCE_FLOOR = 0.35;

function scopeKey(scope: SharedScope): string {
  return scope.kind === "org" ? "org" : `${scope.kind}:${scope.name}`;
}

function cascadeScopes(input: Extract<MemorySearchInput, { purpose: "query" | "wake" }>, catalog: Catalog): string[] {
  const system = catalog.systems.find((item) => item.name === input.cascade.system);
  if (!system) throw new MemoryServiceError("unknown_scope", 400);
  if (input.cascade.domain !== undefined && input.cascade.domain !== system.domain)
    throw new MemoryServiceError("unknown_scope", 400);
  return [
    `system:${system.name}`,
    ...(input.cascade.domain === undefined ? [] : [`domain:${input.cascade.domain}`]),
    "org",
  ];
}

function authorizeReader(catalog: Catalog, principal: Principal): void {
  if (!catalog.users.some((user) => user.name === principal.username))
    throw new MemoryServiceError("auth_invalid", 401);
}

function policy(error: unknown): never {
  if (error instanceof MemoryPolicyError) throw new MemoryServiceError(error.code, 400);
  throw error;
}

async function loadCatalog(loader: () => Promise<Catalog>): Promise<Catalog> {
  try {
    return await loader();
  } catch {
    throw new MemoryServiceError("memory_unavailable", 503, true);
  }
}

export function createSearchService(dependencies: {
  repository: Pick<MemoryRepository, "query">;
  loadCatalog: () => Promise<Catalog>;
  embeddingProvider: EmbeddingProvider;
}) {
  return {
    async search(raw: MemorySearchInput, principal: Principal): Promise<MemorySearchResult> {
      let input: MemorySearchInput;
      try {
        input = MemorySearchInputSchema.parse(raw);
      } catch {
        throw new MemoryServiceError("memory_invalid", 400);
      }
      const catalog = await loadCatalog(dependencies.loadCatalog);
      authorizeReader(catalog, principal);
      const cascadeSelection = cascadeScopes(input, catalog);
      let selectedScopes: string[];
      if (input.purpose === "query" && input.scopes !== undefined && input.scopes.length > 0) {
        selectedScopes = input.scopes.map((scope) => {
          try {
            return scopeKey(validateSharedScope(scope, catalog));
          } catch (error) {
            return policy(error);
          }
        });
      } else {
        selectedScopes = cascadeSelection;
      }

      if (input.purpose === "wake") {
        const countRows = await dependencies.repository.query(
          `SELECT count(*)::int AS count
           FROM wagglebot_memories
           WHERE active = true AND confidence = 1 AND wake = true AND review_after >= CURRENT_DATE
             AND scopes && $1::text[]`,
          [selectedScopes],
        );
        const count = Number(countRows[0]?.count ?? 0);
        const rows = await dependencies.repository.query(
          `SELECT * FROM wagglebot_memories
           WHERE active = true AND confidence = 1 AND wake = true AND review_after >= CURRENT_DATE
             AND scopes && $1::text[]
           ORDER BY CASE WHEN scopes[1] = 'org' THEN 1 WHEN scopes[1] = ('domain:' || $2) THEN 2 ELSE 3 END DESC,
                    updated_at DESC, id ASC
           LIMIT $3`,
          [selectedScopes, input.cascade.domain ?? null, input.limit ?? 3],
        );
        return MemorySearchResultSchema.parse({
          schemaVersion: 1,
          records: rows.map((row) => ({ record: decodeMemoryRecord(row), score: 1 })),
          additionalEligible: Math.max(0, count - rows.length),
        });
      }

      const vector = await dependencies.embeddingProvider.embed(input.query);
      if (vector.length !== 384 || vector.some((value) => !Number.isFinite(value)))
        throw new MemoryServiceError("memory_unavailable", 503, true);
      const countRows = await dependencies.repository.query(
        `SELECT count(*)::int AS count
         FROM wagglebot_memories
         WHERE active = true AND scopes && $1::text[] AND 1 / (1 + (embedding <=> $2::vector)) >= $3`,
        [selectedScopes, `[${vector.join(",")}]`, DISTANCE_FLOOR],
      );
      const count = Number(countRows[0]?.count ?? 0);
      const rows = await dependencies.repository.query(
        `SELECT *, (embedding <=> $2::vector) AS distance
         FROM wagglebot_memories
         WHERE active = true AND scopes && $1::text[] AND 1 / (1 + (embedding <=> $2::vector)) >= $3
         ORDER BY distance ASC, id ASC
         LIMIT $4`,
        [selectedScopes, `[${vector.join(",")}]`, DISTANCE_FLOOR, input.limit ?? 10],
      );
      return MemorySearchResultSchema.parse({
        schemaVersion: 1,
        records: rows.map((row) => ({ record: decodeMemoryRecord(row), score: 1 / (1 + Number(row.distance)) })),
        additionalEligible: Math.max(0, count - rows.length),
      });
    },

    async get(id: string, principal: Principal): Promise<GetMemoryResponse> {
      const catalog = await loadCatalog(dependencies.loadCatalog);
      authorizeReader(catalog, principal);
      const rows = await dependencies.repository.query("SELECT * FROM wagglebot_memories WHERE id = $1", [id]);
      const row = rows[0];
      if (!row) throw new MemoryServiceError("memory_not_found", 404);
      try {
        return GetMemoryResponseSchema.parse({ schemaVersion: 1, record: decodeMemoryRecord(row) });
      } catch (error) {
        if (error instanceof MemoryServiceError) throw error;
        throw new MemoryServiceError("memory_unavailable", 503, true);
      }
    },
  };
}
