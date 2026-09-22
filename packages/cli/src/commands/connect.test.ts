import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runConnect } from "./connect";

const quiet = () => createReporter(() => {}, false);
for (const url of ["https://user:secret@git.internal/company.git", "http://token@git.internal/company.git"]) {
  test(`connect rejects HTTP userinfo without replacing saved settings (${new URL(url).protocol})`, () => {
    const root = mkdtempSync(join(tmpdir(), "wgl-connect-"));
    const configFile = join(root, "config.json");
    const before = '{"companyRepository":"git@git.internal:company.git"}\n';
    writeFileSync(configFile, before);
    const output: string[] = [];
    expect(runConnect({ url, configFile, reporter: createReporter((line) => output.push(line), false) })).toBe(1);
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect(output.join("\n")).not.toContain(url);
    expect(output.join("\n")).not.toContain("secret");
  });
}

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

test("connect rejects malformed HTTP credential URLs without creating a config", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-connect-"));
  const configFile = join(root, "config.json");
  const output: string[] = [];
  expect(
    runConnect({
      url: "https://user:secret@invalid host/company.git",
      configFile,
      reporter: createReporter((line) => output.push(line), false),
    }),
  ).toBe(1);
  expect(output.join("\n")).not.toContain("secret");
  expect(existsSync(configFile)).toBe(false);
});
