import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCompanyRoot, loadCompanyRepo } from "./company";

const scaffold = () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  writeFileSync(join(root, "catalog.yaml"), "kind: User\nmetadata: { name: alice }\nspec: { memberOf: [] }\n");
  writeFileSync(join(root, "registry.base.yaml"), "proxies: []\n");
  writeFileSync(join(root, "skills.list"), "");
  writeFileSync(join(root, "agents.base.list"), "");
  mkdirSync(join(root, "instructions"));
  mkdirSync(join(root, "agents"));
  mkdirSync(join(root, "nested/deep"), { recursive: true });
  return root;
};

test("finds the company root from a nested cwd and reads the pin", () => {
  const root = scaffold();
  expect(findCompanyRoot(join(root, "nested/deep"))).toBe(root);
  expect(loadCompanyRepo(root).pin).toBe("1.4.2");
});

test("no company repo above cwd throws with guidance", () => {
  expect(() => findCompanyRoot(mkdtempSync(join(tmpdir(), "wgl-none-")))).toThrow(/company repository/);
});

test("catalogs/ merges one file per team and wins over a root catalog.yaml", () => {
  const root = scaffold();
  mkdirSync(join(root, "catalogs"));
  writeFileSync(join(root, "catalogs/team-a.yaml"), "kind: User\nmetadata: { name: bob }\nspec: { memberOf: [] }\n");
  writeFileSync(join(root, "catalogs/team-b.yaml"), "kind: User\nmetadata: { name: carol }\nspec: { memberOf: [] }\n");
  const company = loadCompanyRepo(root);
  expect(company.catalogPath).toBe(join(root, "catalogs"));
  expect(company.catalogText).toContain("bob");
  expect(company.catalogText).toContain("carol");
  expect(company.catalogText).not.toContain("alice"); // root catalog.yaml is ignored when catalogs/ exists
});

test("an empty catalogs/ directory throws", () => {
  const root = scaffold();
  mkdirSync(join(root, "catalogs"));
  expect(() => loadCompanyRepo(root)).toThrow(/one catalog file per team/);
});
