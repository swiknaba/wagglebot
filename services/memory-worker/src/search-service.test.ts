import { expect, test } from "bun:test";
import { createSearchService } from "./search-service";

const principal = {
  username: "alice",
  issuedAt: new Date("2026-10-18T10:00:00.000Z"),
  expiresAt: new Date("2026-10-18T11:00:00.000Z"),
  tokenId: "token-1",
  groups: [],
  orgOwner: false,
};
const catalog = {
  users: [{ name: "alice", memberOf: [], orgOwner: false }],
  groups: [],
  systems: [{ name: "billing", owner: "billing-team", domain: "commerce" }],
  domains: [{ name: "commerce", owner: "commerce-team" }],
};

function makeService() {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let embeddings = 0;
  const service = createSearchService({
    repository: {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return (sql.includes("count(*)") ? [{ count: 0 }] : []) as never;
      },
    } as never,
    loadCatalog: async () => catalog as never,
    embeddingProvider: {
      embed: async () => {
        embeddings += 1;
        return Array.from({ length: 384 }, () => 0.1);
      },
    },
  });
  return { service, queries, embeddings: () => embeddings };
}

test("query validates the cascade and filters selected scopes in SQL before ranking and limiting", async () => {
  const { service, queries } = makeService();
  await service.search(
    {
      schemaVersion: 1,
      purpose: "query",
      query: "renewal window",
      cascade: { system: "billing", domain: "commerce", includeOrg: true },
      scopes: [{ kind: "org" }, { kind: "system", name: "billing" }],
      limit: 2,
    },
    principal,
  );
  expect(queries).toHaveLength(2);
  expect(queries[1]?.sql.indexOf("scopes && $1::text[]") ?? -1).toBeLessThan(queries[1]?.sql.indexOf("ORDER BY") ?? -1);
  expect(queries[1]?.sql.indexOf("scopes && $1::text[]") ?? -1).toBeLessThan(queries[1]?.sql.indexOf("LIMIT") ?? -1);
  expect(queries[1]?.values?.[0]).toEqual(["org", "system:billing"]);
});

test("wake search does not embed and reports eligible count before its bounded result limit", async () => {
  const { service, queries, embeddings } = makeService();
  queries.length = 0;
  const result = await service.search(
    {
      schemaVersion: 1,
      purpose: "wake",
      cascade: { system: "billing", domain: "commerce", includeOrg: true },
      limit: 3,
    },
    principal,
  );
  expect(embeddings()).toBe(0);
  expect(result.additionalEligible).toBe(0);
  expect(queries[0]?.sql).toContain("count(*)");
  expect(queries[1]?.sql).toContain("review_after >= CURRENT_DATE");
  expect(queries[1]?.sql).not.toContain("<=>");
});

test("explicit scopes do not bypass catalog consistency checks on the cascade", async () => {
  const { service, queries } = makeService();
  await expect(
    service.search(
      {
        schemaVersion: 1,
        purpose: "query",
        query: "renewal",
        cascade: { system: "billing", domain: "elsewhere", includeOrg: true },
        scopes: [{ kind: "org" }],
        limit: 10,
      },
      principal,
    ),
  ).rejects.toMatchObject({ code: "unknown_scope" });
  expect(queries).toHaveLength(0);
});
