import { expect, test } from "bun:test";
import { resolvePaths } from "./paths";

test("resolves all state locations under <home>/.wagglebot", () => {
  const p = resolvePaths("/tmp/h");
  expect(p.stateDir).toBe("/tmp/h/.wagglebot");
  expect(p.managedFile).toBe("/tmp/h/.wagglebot/managed.json");
  expect(p.backupsDir).toBe("/tmp/h/.wagglebot/backups");
  expect(p.agentsCacheDir).toBe("/tmp/h/.wagglebot/agents-cache");
  expect(p.configFile).toBe("/tmp/h/.wagglebot/config.json");
  expect(p.companyDir).toBe("/tmp/h/.wagglebot/company");
  expect(p.activeCompanyDir).toBe("/tmp/h/.wagglebot/company/active");
  expect(p.runtimeDir).toBe("/tmp/h/.wagglebot/runtime");
});
