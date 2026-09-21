import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runConnect } from "./connect";

const quiet = () => createReporter(() => {}, false);

test("connect creates a private config file with the repository URL", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-connect-"));
  const configFile = join(root, ".wagglebot", "config.json");

  expect(
    runConnect({
      url: "git@github.com:platform/company.git",
      configFile,
      reporter: quiet(),
    }),
  ).toBe(0);

  expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
    companyRepository: "git@github.com:platform/company.git",
  });
  expect(statSync(configFile).mode & 0o777).toBe(0o600);
});

test("connect preserves unknown top-level configuration keys", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-connect-"));
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify({ selectedHarnesses: ["codex"], futureSetting: { enabled: true } }));
  chmodSync(configFile, 0o600);

  expect(
    runConnect({
      url: "https://github.com/platform/company.git",
      configFile,
      reporter: quiet(),
    }),
  ).toBe(0);

  expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
    selectedHarnesses: ["codex"],
    futureSetting: { enabled: true },
    companyRepository: "https://github.com/platform/company.git",
  });
  expect(statSync(configFile).mode & 0o777).toBe(0o600);
});
