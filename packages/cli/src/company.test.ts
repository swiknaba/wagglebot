import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "./company";

const user = (name: string) => `kind: User\nmetadata: { name: ${name} }\nspec: { memberOf: [] }\n`;

const scaffold = (wagglebot?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  const pkg = { dependencies: { wagglebot: "1.4.2" }, ...(wagglebot === undefined ? {} : { wagglebot }) };
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
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

test("a marked repository identifies the company root from a nested cwd and reads the pin", () => {
  const root = scaffold();
  expect(findCompanyRoot(join(root, "nested/deep"))).toBe(root);
  expect(loadCompanyRepo(root).pin).toBe("1.4.2");
});

test("no marked company repository above cwd throws with guidance", () => {
  expect(() => findCompanyRoot(mkdtempSync(join(tmpdir(), "wgl-none-")))).toThrow(/company repository/);
});

test("merges catalog files in company and sorted team order", () => {
  const company = loadCompanyRepo(scaffold());
  expect(company.teams.map((t) => t.name)).toEqual(["payments", "search"]);
  expect(company.catalog).toEqual({
    text: `${user("alice")}\n---\n${user("bob")}`,
    path: expect.stringMatching(/teams\/payments\/catalog\.yaml, .*teams\/search\/catalog\.yaml$/),
  });
  expect(company.company.registryText).toBe("proxies: []\n");
  expect(company.company.skillsListText).toBe("");
  expect(company.teams[0]?.registryText).toBe("proxies: []\n");
  expect(company.teams[1]?.registryText).toBeUndefined();
});

test("merges the company catalog before catalogs from unsorted team directories", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-catalog-order-"));
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.2.3" } }));
  mkdirSync(join(root, "company", "instructions"), { recursive: true });
  writeFileSync(join(root, "company", "catalog.yaml"), user("company-user"));
  mkdirSync(join(root, "teams", "zulu"), { recursive: true });
  writeFileSync(join(root, "teams", "zulu", "catalog.yaml"), user("zulu-user"));
  mkdirSync(join(root, "teams", "alpha"), { recursive: true });
  writeFileSync(join(root, "teams", "alpha", "catalog.yaml"), user("alpha-user"));

  expect(loadCompanyRepo(root).catalog).toEqual({
    text: `${user("company-user")}\n---\n${user("alpha-user")}\n---\n${user("zulu-user")}`,
    path: [
      join(root, "company", "catalog.yaml"),
      join(root, "teams", "alpha", "catalog.yaml"),
      join(root, "teams", "zulu", "catalog.yaml"),
    ].join(", "),
  });
});

test("layersFor returns the company layer first, then the named teams in order", () => {
  const company = loadCompanyRepo(scaffold());
  expect(company.layersFor(["search"]).map((l) => l.name)).toEqual(["company", "search"]);
  expect(company.layersFor(["search", "payments"]).map((l) => l.name)).toEqual(["company", "payments", "search"]);
  expect(company.layersFor(["nobody"]).map((l) => l.name)).toEqual(["company"]);
});

test("a marked repository without a catalog loads with no catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-nocat-"));
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.2.3" } }));
  mkdirSync(join(root, "company", "instructions"), { recursive: true });
  expect(loadCompanyRepo(root).catalog).toBeUndefined();
});

test("a missing company marker makes the loader name its path", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-no-marker-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.2.3" } }));
  mkdirSync(join(root, "company", "instructions"), { recursive: true });
  expect(() => loadCompanyRepo(root)).toThrow(join(root, "wagglebot.yaml"));
});

test.each([
  ["extra fields", "version: 1\nkind: company\nother: value\n"],
  ["another version", "version: 2\nkind: company\n"],
  ["another kind", "version: 1\nkind: project\n"],
  ["malformed YAML", "version: 1\nkind: company\n: malformed\n"],
])("rejects a marker with %s", (_description, marker) => {
  const root = scaffold();
  writeFileSync(join(root, "wagglebot.yaml"), marker);
  expect(() => loadCompanyRepo(root)).toThrow(join(root, "wagglebot.yaml"));
});

test("a package name does not select company mode", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-package-name-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "company", dependencies: { wagglebot: "1.2.3" } }));
  mkdirSync(join(root, "company", "instructions"), { recursive: true });
  expect(() => findCompanyRoot(root)).toThrow(/company repository/);
});

test("a teams/ directory that matches no Group is a hard error", () => {
  const company = loadCompanyRepo(scaffold());
  expect(() => assertTeamDirsKnown(company, ["payments"])).toThrow(/teams\/search/);
  expect(() => assertTeamDirsKnown(company, ["payments", "search"])).not.toThrow();
});

test("reads wagglebot.organization from package.json and defaults to an empty list", () => {
  expect(loadCompanyRepo(scaffold({ organization: ["github.com/acme"] })).organization).toEqual(["github.com/acme"]);
  expect(loadCompanyRepo(scaffold()).organization).toEqual([]);
});

test("a malformed wagglebot.organization is a hard error that names the key", () => {
  expect(() => loadCompanyRepo(scaffold({ organization: "github.com/acme" }))).toThrow(/wagglebot\.organization/);
});

test("a malformed wagglebot.organization below the company root does not stop the walk", () => {
  const root = scaffold();
  // A nested package of the same repository. It pins nothing, so it is not the company root.
  writeFileSync(join(root, "nested/package.json"), JSON.stringify({ wagglebot: { organization: "github.com/acme" } }));
  expect(findCompanyRoot(join(root, "nested/deep"))).toBe(root);
});
