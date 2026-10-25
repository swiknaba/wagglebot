import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSecretScanner as createSharedSecretScanner,
  ScannerUnavailableError as SharedScannerUnavailableError,
} from "@wagglebot/secret-scanner";
import { createSecretScanner, type GitleaksRunner, ScannerUnavailableError } from "./scanner";

test("worker compatibility exports preserve the shared scanner and error identity", () => {
  expect(createSecretScanner).toBe(createSharedSecretScanner);
  expect(ScannerUnavailableError).toBe(SharedScannerUnavailableError);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(runner: GitleaksRunner) {
  const root = mkdtempSync(join(tmpdir(), "memory-scanner-test-"));
  roots.push(root);
  const executable = join(root, "gitleaks");
  writeFileSync(executable, "pinned fake gitleaks executable");
  const tempRoot = join(root, "scan-tmp");
  mkdirSync(tempRoot, { mode: 0o700 });
  return {
    root,
    tempRoot,
    scanner: createSecretScanner({
      gitleaks: {
        executable,
        version: "8.30.1",
        sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      },
      runner,
      clock: globalThis,
      tempRoot,
    }),
  };
}

const version = { exitCode: 0, stdout: "8.30.1\n", stderr: "" };

test("scans text and persisted DTOs with built-in and pinned gitleaks rules", async () => {
  const calls: string[][] = [];
  const runner: GitleaksRunner = async (_executable, args, options) => {
    calls.push(args);
    if (args[0] === "version") return version;
    expect(options.cwd).toBeTruthy();
    expect(options.env).toMatchObject({ HOME: options.cwd, USERPROFILE: options.cwd });
    expect(options.env?.GITLEAKS_CONFIG).toBeUndefined();
    const reportPath = args[args.indexOf("--report-path") + 1];
    const sourceDirectory = args[args.indexOf("--source") + 1];
    if (typeof sourceDirectory === "string") expect(statSync(sourceDirectory).mode & 0o777).toBe(0o700);
    if (typeof sourceDirectory === "string")
      expect(statSync(join(sourceDirectory, "scan.txt")).mode & 0o777).toBe(0o600);
    if (typeof reportPath === "string") {
      expect(statSync(reportPath).mode & 0o777).toBe(0o600);
      writeFileSync(
        reportPath,
        JSON.stringify([{ RuleID: "generic-api-key", StartLine: 1, StartColumn: 1, Secret: "must-not-return" }]),
      );
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const { scanner, tempRoot } = setup(runner);
  const result = await scanner.scanText("safe text");
  expect(result.findings.map((finding) => finding.ruleId)).toContain("gitleaks:generic-api-key");
  expect(JSON.stringify(result)).not.toContain("must-not-return");
  expect((await scanner.scanPersistedDTO({ title: "safe", provenance: [{ source: "notes" }] })).count).toBe(1);
  expect(calls.some((args) => args.includes("--no-git"))).toBe(true);
  expect(calls.some((args) => args.includes("--ignore-gitleaks-allow"))).toBe(true);
  expect(readdirSync(tempRoot)).toEqual([]);
});

test("scans raw persisted string values before JSON escaping can hide control characters", async () => {
  const runner: GitleaksRunner = async (_executable, args) => {
    if (args[0] === "version") return version;
    const reportPath = args[args.indexOf("--report-path") + 1];
    if (typeof reportPath === "string") writeFileSync(reportPath, "[]");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const { scanner } = setup(runner);
  const result = await scanner.scanPersistedDTO({ content: "safe\u0007text" });
  expect(result.findings.map((finding) => finding.ruleId)).toContain("control_character");
});

test("rejects built-in secret and control-character findings without returning the matched content", async () => {
  const runner: GitleaksRunner = async (_executable, args) =>
    args[0] === "version"
      ? version
      : (() => {
          const reportPath = args[args.indexOf("--report-path") + 1];
          if (typeof reportPath === "string") writeFileSync(reportPath, "[]");
          return { exitCode: 0, stdout: "", stderr: "" };
        })();
  const { scanner } = setup(runner);
  const secret = "Bearer synthetic-token-value-123456";
  const result = await scanner.scanText(`${secret}\u0007`);
  expect(result.findings.map((finding) => finding.ruleId)).toContain("bearer_token");
  expect(result.findings.map((finding) => finding.ruleId)).toContain("control_character");
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("fails closed when executable version or checksum differs from the configured pin", async () => {
  const runner: GitleaksRunner = async (_executable, args) =>
    args[0] === "version" ? { ...version, stdout: "gitleaks version 8.29.0" } : { exitCode: 0, stdout: "", stderr: "" };
  const { scanner } = setup(runner);
  await expect(scanner.scanText("clean")).rejects.toMatchObject({ code: "scanner_unavailable" });
  const { scanner: checksumScanner, root } = setup(async (_executable, args) =>
    args[0] === "version" ? version : { exitCode: 0, stdout: "", stderr: "" },
  );
  writeFileSync(join(root, "gitleaks"), "replaced executable");
  await expect(checksumScanner.scanText("clean")).rejects.toMatchObject({ code: "scanner_unavailable" });
});

test("assertReady rechecks the configured binary pin without scanning content", async () => {
  const calls: string[][] = [];
  const { scanner, root } = setup(async (_executable, args) => {
    calls.push(args);
    return args[0] === "version" ? version : { exitCode: 0, stdout: "", stderr: "" };
  });
  await scanner.assertReady();
  expect(calls).toEqual([["version"]]);

  writeFileSync(join(root, "gitleaks"), "replaced executable");
  await expect(scanner.assertReady()).rejects.toMatchObject({ code: "scanner_unavailable" });
});

test("bounds runner time/output and exposes only a safe scanner error", async () => {
  let limits: { timeoutMs: number; maxOutputBytes: number } | undefined;
  const runner: GitleaksRunner = async (_executable, args, options) => {
    limits = { timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes };
    if (args[0] === "version") return version;
    throw new Error("scanner spilled synthetic-sensitive-content");
  };
  const { scanner } = setup(runner);
  await expect(scanner.scanText("clean")).rejects.toMatchObject({
    code: "scanner_unavailable",
    message: "scanner unavailable",
  });
  expect(limits?.timeoutMs).toBeGreaterThan(0);
  expect(limits?.maxOutputBytes).toBeGreaterThan(0);
  expect(JSON.stringify(limits)).not.toContain("synthetic-sensitive-content");
});

test("uses argument arrays and removes protected scan material after scan failure", async () => {
  let seenArgs: string[] | undefined;
  const runner: GitleaksRunner = async (_executable, args) => {
    seenArgs = args;
    if (args[0] === "version") return version;
    throw new Error("execution failed");
  };
  const { scanner, tempRoot, root } = setup(runner);
  await expect(scanner.scanText("clean; echo unsafe")).rejects.toMatchObject({ code: "scanner_unavailable" });
  expect(Array.isArray(seenArgs)).toBe(true);
  expect(seenArgs).not.toContain("clean; echo unsafe");
  expect(readdirSync(tempRoot)).toEqual([]);
  expect(readFileSync(join(root, "gitleaks"), "utf8")).toBe("pinned fake gitleaks executable");
});

test("runs the pinned executable with the production subprocess adapter", async () => {
  const { root, tempRoot } = setup(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const executable = join(root, "gitleaks");
  const script = [
    "#!/usr/bin/env node",
    'const { writeFileSync } = require("node:fs");',
    "const args = process.argv.slice(2);",
    'if (args[0] === "version") process.stdout.write("gitleaks version 8.30.1\\n");',
    'else writeFileSync(args[args.indexOf("--report-path") + 1], "[]");',
  ].join("\n");
  writeFileSync(executable, script);
  chmodSync(executable, 0o700);
  const scanner = createSecretScanner({
    gitleaks: {
      executable,
      version: "8.30.1",
      sha256: createHash("sha256").update(script).digest("hex"),
    },
    tempRoot,
  });
  await expect(scanner.scanText("clean content")).resolves.toEqual({ findings: [], count: 0 });
  expect(readdirSync(tempRoot)).toEqual([]);
});
