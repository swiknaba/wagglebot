import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "./company";

const user = (name: string) => `kind: User\nmetadata: { name: ${name} }\nspec: { memberOf: [] }\n`;

const scaffold = () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  mkdirSync(join(root, "company/instructions"), { recursive: true });
  writeFileSync(join(root, "company/registry.yaml"), "proxies: []\n");
  writeFileSync(join(root, "company/skills.list"), "");
  mkdirSync(join(root, "teams/payments"), { recursive: true });
  writeFileSync(join(root, "teams/payments/catalog.yaml"), user("alice"));
  writeFileSync(join(root, "teams/payments/registry.yaml"), "proxies: []\n");
  mkdirSync(join(root, "teams/search"), { recursive: true });
  writeFileSync(join(root, "teams/search/catalog.yaml"), user("bob"));
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

test("merges every catalog.yaml and exposes one layer per team directory", () => {
  const company = loadCompanyRepo(scaffold());
  expect(company.teams.map((t) => t.name)).toEqual(["payments", "search"]);
  expect(company.catalogText).toContain("alice");
  expect(company.catalogText).toContain("bob");
  expect(company.company.registryText).toBe("proxies: []\n");
  expect(company.company.skillsListText).toBe("");
  expect(company.teams[0]?.registryText).toBe("proxies: []\n");
  expect(company.teams[1]?.registryText).toBeUndefined();
});

test("layersFor returns the company layer first, then the named teams in order", () => {
  const company = loadCompanyRepo(scaffold());
  expect(company.layersFor(["search"]).map((l) => l.name)).toEqual(["company", "search"]);
  expect(company.layersFor(["search", "payments"]).map((l) => l.name)).toEqual(["company", "payments", "search"]);
  expect(company.layersFor(["nobody"]).map((l) => l.name)).toEqual(["company"]);
});

test("a repository without any catalog.yaml throws", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-nocat-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  mkdirSync(join(root, "company"));
  expect(() => loadCompanyRepo(root)).toThrow(/catalog\.yaml/);
});

test("a teams/ directory that matches no Group is a hard error", () => {
  const company = loadCompanyRepo(scaffold());
  expect(() => assertTeamDirsKnown(company, ["payments"])).toThrow(/teams\/search/);
  expect(() => assertTeamDirsKnown(company, ["payments", "search"])).not.toThrow();
});
