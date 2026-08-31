import { expect, test } from "bun:test";
import { findUser, loadCatalog, nearMatches, teamsOf } from "./catalog";

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

test("loads a valid catalog and resolves users and teams", () => {
  const catalog = loadCatalog(CATALOG, "catalog.yaml");
  expect(findUser(catalog, "alice")?.orgOwner).toBe(true);
  expect(teamsOf(catalog, "bob")).toEqual(["team-payments"]);
});

test("near matches suggest close usernames", () => {
  const catalog = loadCatalog(CATALOG, "catalog.yaml");
  expect(nearMatches(catalog, "alcie")).toEqual(["alice"]);
});

test("a system naming an unknown group is a hard error naming file and value", () => {
  const broken = CATALOG.replace("owner: team-payments, domain", "owner: team-ghost, domain");
  expect(() => loadCatalog(broken, "catalog.yaml")).toThrow(/catalog\.yaml.*team-ghost/);
});

test("duplicate names of one kind are a hard error", () => {
  const dup = `${CATALOG}\n---\napiVersion: backstage.io/v1alpha1\nkind: User\nmetadata: { name: bob }\nspec: { memberOf: [team-payments] }\n`;
  expect(() => loadCatalog(dup, "catalog.yaml")).toThrow(/bob/);
});
