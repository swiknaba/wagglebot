import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "./catalog";

function fixture(catalog: string, team = "payments") {
  const root = mkdtempSync(join("/tmp", "waggle-registry-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  mkdirSync(join(root, "company"), { recursive: true });
  mkdirSync(join(root, "teams", team), { recursive: true });
  writeFileSync(join(root, "company", "catalog.yaml"), catalog);
  writeFileSync(join(root, "tool_catalog.yaml"), "version: 1\ntitle: Tools\nfamilies: []\n");
  return root;
}

const entities = `kind: Group\nmetadata: { name: payments }\nspec: { members: [alice] }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [payments] }\n`;

test("loads users, groups, tool catalog, and registry layers", () => {
  const root = fixture(entities);
  const source = loadCatalog(root, "0123456789abcdef0123456789abcdef01234567");
  expect(source.catalog.groupsFor("alice")).toEqual(["payments"]);
  expect(source.toolCatalog.title).toBe("Tools");
  expect(source.teams.has("payments")).toBe(true);
});

test("rejects duplicate users and unknown memberships", () => {
  expect(() => loadCatalog(fixture(`${entities}---\nkind: User\nmetadata: { name: alice }`), "0".repeat(40))).toThrow(
    /duplicate/i,
  );
  expect(() =>
    loadCatalog(fixture("kind: User\nmetadata: { name: alice }\nspec: { memberOf: [missing] }"), "0".repeat(40)),
  ).toThrow(/unknown/i);
});
