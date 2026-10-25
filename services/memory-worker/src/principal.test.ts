import { expect, test } from "bun:test";
import { createMemoryPrincipalResolver, resolvePrincipal } from "./principal";

const catalog = {
  domains: [{ name: "payments", owner: "team-payments" }],
  systems: [{ name: "checkout", owner: "team-payments", domain: "payments" }],
  groups: [{ name: "team-payments", members: ["alice"] }],
  users: [{ name: "alice", memberOf: [], orgOwner: true }],
};
const verified = {
  username: "alice",
  audience: "wagglebot-memory" as const,
  issuedAt: new Date("2026-10-06T09:00:00.000Z"),
  expiresAt: new Date("2026-10-06T09:15:00.000Z"),
  tokenId: "jti_abcdefghijklmnopqrstuvwxyz12",
};

test("derives principal privileges from the current catalog", () => {
  expect(resolvePrincipal(verified, catalog, new Date("2026-10-06T09:05:00.000Z"))).toMatchObject({
    username: "alice",
    groups: ["team-payments"],
    orgOwner: true,
  });
});

test("rejects a user removed from the current catalog", () => {
  expect(() => resolvePrincipal(verified, { ...catalog, users: [] }, new Date("2026-10-06T09:05:00.000Z"))).toThrow(
    /auth_invalid/,
  );
});

test("rejects wrong audience and expired verified claims", () => {
  expect(() => resolvePrincipal({ ...verified, audience: "wagglebot-registry" }, catalog)).toThrow(/auth_invalid/);
  expect(() => resolvePrincipal(verified, catalog, new Date("2026-10-06T09:15:00.001Z"))).toThrow(/auth_invalid/);
});

test("the injectable verifier is requested for memory and the catalog is reloaded for each token", async () => {
  const audiences: string[] = [];
  let loads = 0;
  const resolve = createMemoryPrincipalResolver({
    verifyToken: async (_token, audience) => {
      audiences.push(audience);
      return verified;
    },
    loadCatalog: async () => {
      loads += 1;
      return catalog;
    },
    clock: () => new Date("2026-10-06T09:05:00.000Z"),
  });
  await resolve("opaque-test-token");
  await resolve("opaque-test-token");
  expect(audiences).toEqual(["wagglebot-memory", "wagglebot-memory"]);
  expect(loads).toBe(2);
});
