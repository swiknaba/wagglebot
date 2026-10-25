import { expect, test } from "bun:test";
import { findUser, loadCatalog, teamsOf } from "./catalog";

const CATALOG = `
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata: { name: payments }
spec: { owner: team-payments }
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata: { name: payments-platform }
spec: { owner: team-payments, domain: payments }
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata: { name: team-payments }
spec: { type: team, members: [alice, bob] }
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations: { "wagglebot.dev/org-owner": "true" }
spec: { memberOf: [team-payments] }
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata: { name: bob }
spec: { memberOf: [team-payments] }
`;

test("the shared catalog loader preserves the user and team lookup contract", () => {
  const catalog = loadCatalog(CATALOG, "catalog.yaml");
  expect(findUser(catalog, "alice")?.orgOwner).toBe(true);
  expect(teamsOf(catalog, "bob")).toEqual(["team-payments"]);
});

test("the shared catalog loader rejects an invalid owner relationship", () => {
  expect(() =>
    loadCatalog(CATALOG.replace("owner: team-payments, domain", "owner: team-ghost, domain"), "catalog.yaml"),
  ).toThrow(/catalog\.yaml.*team-ghost/);
});
