import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompanyCatalog, type GitExecutor, identifyProject } from "./project-identity";

const companyCatalog = (): CompanyCatalog => ({
  systems: [{ name: "payments-platform", owner: "team-payments", domain: "payments" }],
});

const componentDeclaration = (component: string, system = "payments-platform", owner = "team-payments") =>
  `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: ${component}\nspec:\n  type: service\n  owner: ${owner}\n  system: ${system}\n`;

const fixtureRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "wgl-identity-"));
  execFileSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    {
      cwd: repo,
    },
  );
  return repo;
};

test("wagglebot component declaration wins over catalog-info", async () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo, ".wagglebot"));
  writeFileSync(join(repo, ".wagglebot", "catalog.yaml"), componentDeclaration("preferred-component"));
  writeFileSync(join(repo, "catalog-info.yaml"), componentDeclaration("backstage-component"));

  expect((await identifyProject(repo, companyCatalog())).component).toBe("preferred-component");
});

test("uses the closest enclosing component declaration", async () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo, ".wagglebot"));
  writeFileSync(join(repo, ".wagglebot", "catalog.yaml"), componentDeclaration("root-component"));
  const nested = join(repo, "packages", "payments");
  mkdirSync(join(nested, ".wagglebot"), { recursive: true });
  writeFileSync(join(nested, ".wagglebot", "catalog.yaml"), componentDeclaration("payments-component"));

  expect((await identifyProject(nested, companyCatalog())).component).toBe("payments-component");
});

test("reports a missing declaration without inventing shared identity", async () => {
  const identity = await identifyProject(fixtureRepo(), companyCatalog());

  expect(identity.catalogState).toBe("missing");
  expect(identity.component).toBeUndefined();
  expect(identity.system).toBeUndefined();
  expect(identity.catalogWarning).toMatch(/catalog-info\.yaml/);
});

test("rejects a component declaration that names an unknown system", async () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "catalog-info.yaml"), componentDeclaration("pay-api", "unknown-system"));

  await expect(identifyProject(repo, companyCatalog())).rejects.toThrow(/unknown system/i);
});

test("reports detached HEAD without reading the Git remote", async () => {
  const repo = fixtureRepo();
  execFileSync("git", ["checkout", "--quiet", "--detach"], { cwd: repo });
  const calls: string[][] = [];
  const recordingGit: GitExecutor = async (args, cwd) => {
    calls.push(args);
    return new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe" }).stdout);
  };

  const identity = await identifyProject(repo, companyCatalog(), recordingGit);

  expect(identity.branch).toBeUndefined();
  expect(calls.flat()).not.toContain("remote");
});
