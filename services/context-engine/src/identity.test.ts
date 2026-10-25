import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalBrainError } from "@wagglebot/local-brain";
import { fixtureRepo } from "../../../packages/local-brain/src/memory/test-fixture";
import { identifyProjectWithCompanyCatalog } from "./identity";

const scaffoldCompany = (root: string, domain = "checkout-domain"): string => {
  mkdirSync(join(root, "company"), { recursive: true });
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  writeFileSync(
    join(root, "company", "catalog.yaml"),
    `kind: Group\nmetadata: { name: team-payments }\nspec: {}\n---\nkind: Domain\nmetadata: { name: ${domain} }\nspec: { owner: team-payments }\n---\nkind: System\nmetadata: { name: checkout }\nspec: { owner: team-payments, domain: ${domain} }\n`,
  );
  return root;
};

const scaffoldProject = (): string => {
  const root = fixtureRepo();
  writeFileSync(
    join(root, "catalog-info.yaml"),
    "kind: Component\nmetadata: { name: checkout-ui }\nspec: { owner: team-payments, system: checkout }\n",
  );
  return root;
};

test("uses the configured local company catalog and reloads it for each identity read", async () => {
  const companyRoot = scaffoldCompany(mkdtempSync(join(tmpdir(), "context-company-")));
  const projectRoot = scaffoldProject();
  const first = await identifyProjectWithCompanyCatalog(projectRoot, { companyRoot });
  expect(first).toMatchObject({ domain: "checkout-domain", catalogState: "resolved" });

  scaffoldCompany(companyRoot, "inventory-domain");
  const reloaded = await identifyProjectWithCompanyCatalog(projectRoot, { companyRoot });
  expect(reloaded).toMatchObject({ domain: "inventory-domain", catalogState: "resolved" });
});

test("uses the active cached company when configured root is absent and preserves missing-catalog behavior", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "context-home-"));
  const active = join(homeDirectory, ".wagglebot", "company", "active");
  const checkout = join(mkdtempSync(join(tmpdir(), "context-checkout-")), "checkout");
  scaffoldCompany(join(checkout, "platform", "company"));
  mkdirSync(join(homeDirectory, ".wagglebot", "company"), { recursive: true });
  symlinkSync(checkout, active, "dir");
  writeFileSync(
    join(homeDirectory, ".wagglebot", "config.json"),
    JSON.stringify({ companySubdirectory: "platform/company" }),
  );
  const projectRoot = scaffoldProject();

  const cached = await identifyProjectWithCompanyCatalog(projectRoot, { companyRoot: null, homeDirectory });
  expect(cached).toMatchObject({ domain: "checkout-domain", catalogState: "resolved" });

  const missing = await identifyProjectWithCompanyCatalog(projectRoot, {
    companyRoot: null,
    homeDirectory: mkdtempSync(join(tmpdir(), "context-empty-home-")),
  });
  expect(missing).toMatchObject({ component: "checkout-ui", system: "checkout", catalogState: "missing" });
  expect(missing.domain).toBeUndefined();
});

test("falls back to local identity when automatic company cache config is malformed or unsafe", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "context-config-home-"));
  scaffoldCompany(join(homeDirectory, ".wagglebot", "company", "active"));
  const configPath = join(homeDirectory, ".wagglebot", "config.json");
  const projectRoot = scaffoldProject();

  writeFileSync(configPath, "{ malformed");
  const malformed = await identifyProjectWithCompanyCatalog(projectRoot, { companyRoot: null, homeDirectory });
  expect(malformed.catalogState).toBe("missing");

  writeFileSync(configPath, JSON.stringify({ companySubdirectory: "../../outside" }));
  const unsafe = await identifyProjectWithCompanyCatalog(projectRoot, { companyRoot: null, homeDirectory });
  expect(unsafe.catalogState).toBe("missing");
});

test("refuses a cached company subdirectory symlink that escapes the active checkout", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "context-escape-home-"));
  const checkout = join(mkdtempSync(join(tmpdir(), "context-checkout-")), "checkout");
  mkdirSync(join(checkout, "platform"), { recursive: true });
  const outside = scaffoldCompany(mkdtempSync(join(tmpdir(), "context-outside-company-")));
  symlinkSync(outside, join(checkout, "platform", "company"), "dir");
  const active = join(homeDirectory, ".wagglebot", "company", "active");
  mkdirSync(join(homeDirectory, ".wagglebot", "company"), { recursive: true });
  symlinkSync(checkout, active, "dir");
  writeFileSync(
    join(homeDirectory, ".wagglebot", "config.json"),
    JSON.stringify({ companySubdirectory: "platform/company" }),
  );

  const identity = await identifyProjectWithCompanyCatalog(scaffoldProject(), { companyRoot: null, homeDirectory });

  expect(identity.catalogState).toBe("missing");
  expect(identity.domain).toBeUndefined();
});

test("fails with a content-free error for an invalid explicitly configured catalog", async () => {
  const companyRoot = scaffoldCompany(mkdtempSync(join(tmpdir(), "context-invalid-company-")));
  writeFileSync(
    join(companyRoot, "company", "catalog.yaml"),
    "kind: Group\nmetadata: { name: SYNTHETIC_PRIVATE_CATALOG_TEXT }\n---\nkind: Group\nmetadata: { name: SYNTHETIC_PRIVATE_CATALOG_TEXT }\n",
  );
  await expect(identifyProjectWithCompanyCatalog(scaffoldProject(), { companyRoot })).rejects.toMatchObject({
    code: "project_not_found",
    message: "Company catalog configuration is invalid.",
  } satisfies Partial<LocalBrainError>);
});
