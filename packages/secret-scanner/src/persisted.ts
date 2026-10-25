import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretRuleId, scanText as scanBuiltInText } from "./scanner";

const REQUIRED_GITLEAKS_VERSION = "8.30.1";
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 100 * 1024 * 1024;

export type MemoryScanFinding = { ruleId: string; line: number; column: number };
export type MemoryScanResult = { findings: MemoryScanFinding[]; count: number };
export type GitleaksRunnerOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  clock: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
export type GitleaksRunner = (
  executable: string,
  args: string[],
  options: GitleaksRunnerOptions,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export class ScannerUnavailableError extends Error {
  readonly code = "scanner_unavailable" as const;

  constructor() {
    super("scanner unavailable");
    this.name = "ScannerUnavailableError";
  }
}

function runGitleaks(
  executable: string,
  args: string[],
  options: GitleaksRunnerOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = options.clock.setTimeout(() => {
      overflow = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const finish = (error?: Error, result?: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      options.clock.clearTimeout(timer);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
      else reject(new Error("scanner failed"));
    };
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) + chunk.byteLength > options.maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", () => finish(new Error("scanner failed")));
    child.once("close", (code) => {
      if (overflow) finish(new Error("scanner bounds exceeded"));
      else if (code === null) finish(new Error("scanner failed"));
      else finish(undefined, { exitCode: code, stdout, stderr });
    });
  });
}

const reportInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ScannerUnavailableError();
  return value;
};

function parseGitleaksReport(report: string): MemoryScanFinding[] {
  let value: unknown;
  try {
    value = JSON.parse(report);
  } catch {
    throw new ScannerUnavailableError();
  }
  if (!Array.isArray(value)) throw new ScannerUnavailableError();
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ScannerUnavailableError();
    const row = item as Record<string, unknown>;
    if (typeof row.RuleID !== "string" || row.RuleID.length === 0) throw new ScannerUnavailableError();
    const rawRuleId = row.RuleID;
    const ruleId = rawRuleId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "unknown";
    return {
      ruleId: `gitleaks:${ruleId}`,
      line: reportInteger(row.StartLine),
      column: reportInteger(row.StartColumn),
    };
  });
}

function toSafeFindings(findings: MemoryScanFinding[]): MemoryScanResult {
  const ordered = findings.sort(
    (left, right) => left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId),
  );
  return { findings: ordered, count: ordered.length };
}

function persistedStrings(value: unknown): string[] {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not serializable");
    const normalized: unknown = JSON.parse(serialized);
    const strings: string[] = [];
    const visit = (item: unknown): void => {
      if (typeof item === "string") {
        strings.push(item);
      } else if (Array.isArray(item)) {
        for (const child of item) visit(child);
      } else if (typeof item === "object" && item !== null) {
        for (const [key, child] of Object.entries(item)) {
          strings.push(key);
          visit(child);
        }
      }
    };
    visit(normalized);
    return strings;
  } catch {
    throw new ScannerUnavailableError();
  }
}

const isolatedEnvironment = (): NodeJS.ProcessEnv => ({
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
});

export function createSecretScanner(options: {
  gitleaks: { executable: string; version: string; sha256: string };
  runner?: GitleaksRunner;
  clock?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  tempRoot?: string;
}): {
  assertReady(): Promise<void>;
  scanText(text: string): Promise<MemoryScanResult>;
  scanPersistedDTO(value: unknown): Promise<MemoryScanResult>;
} {
  const run = options.runner ?? runGitleaks;
  const clock = options.clock ?? globalThis;

  const verifyPin = async (): Promise<void> => {
    try {
      if (options.gitleaks.version !== REQUIRED_GITLEAKS_VERSION || !/^[a-f0-9]{64}$/iu.test(options.gitleaks.sha256)) {
        throw new Error("pin mismatch");
      }
      const binary = lstatSync(options.gitleaks.executable);
      if (binary.isSymbolicLink() || !binary.isFile() || binary.size > MAX_EXECUTABLE_BYTES)
        throw new Error("binary invalid");
      const digest = createHash("sha256").update(readFileSync(options.gitleaks.executable)).digest("hex");
      if (digest !== options.gitleaks.sha256.toLowerCase()) throw new Error("checksum mismatch");
      const versionResult = await run(options.gitleaks.executable, ["version"], {
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        clock,
      });
      if (
        versionResult.exitCode !== 0 ||
        Buffer.byteLength(versionResult.stdout) + Buffer.byteLength(versionResult.stderr) > MAX_OUTPUT_BYTES ||
        !/^(?:gitleaks version )?v?8\.30\.1(?:\s|$)/u.test(versionResult.stdout.trim())
      ) {
        throw new Error("version mismatch");
      }
    } catch {
      throw new ScannerUnavailableError();
    }
  };

  const scanText = async (text: string): Promise<MemoryScanResult> => {
    const textBytes = Buffer.byteLength(text, "utf8");
    if (textBytes > MAX_TEXT_BYTES) throw new ScannerUnavailableError();
    await verifyPin();

    let directory: string | undefined;
    let scanResult: MemoryScanResult | undefined;
    let failed = false;
    try {
      directory = mkdtempSync(join(options.tempRoot ?? tmpdir(), "wagglebot-memory-scan-"));
      chmodSync(directory, 0o700);
      const sourceDirectory = join(directory, "source");
      mkdirSync(sourceDirectory, { mode: 0o700 });
      chmodSync(sourceDirectory, 0o700);
      const sourcePath = join(sourceDirectory, "scan.txt");
      const reportPath = join(directory, "report.json");
      writeFileSync(sourcePath, text, { flag: "wx", mode: 0o600 });
      const reportFd = openSync(reportPath, "wx", 0o600);
      closeSync(reportFd);

      const result = await run(
        options.gitleaks.executable,
        [
          "detect",
          "--no-git",
          "--ignore-gitleaks-allow",
          "--source",
          sourceDirectory,
          "--report-format",
          "json",
          "--report-path",
          reportPath,
          "--exit-code",
          "0",
          "--no-banner",
        ],
        {
          timeoutMs: TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          clock,
          cwd: directory,
          env: { ...isolatedEnvironment(), HOME: directory, USERPROFILE: directory },
        },
      );
      if (
        result.exitCode !== 0 ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES
      ) {
        throw new ScannerUnavailableError();
      }
      const reportStat = lstatSync(reportPath);
      if (!reportStat.isFile() || reportStat.size > MAX_REPORT_BYTES) throw new ScannerUnavailableError();
      chmodSync(reportPath, 0o600);
      const reportReadFd = openSync(reportPath, "r");
      let report: string;
      try {
        const buffer = Buffer.alloc(reportStat.size);
        readSync(reportReadFd, buffer, 0, buffer.length, 0);
        report = buffer.toString("utf8");
      } finally {
        closeSync(reportReadFd);
      }

      const builtIn = scanBuiltInText(text).findings.map((finding) => ({ ...finding }));
      const external = parseGitleaksReport(report);
      scanResult = toSafeFindings([...builtIn, ...external]);
    } catch {
      failed = true;
    } finally {
      if (directory !== undefined) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          failed = true;
        }
      }
    }
    if (failed || scanResult === undefined) throw new ScannerUnavailableError();
    return scanResult;
  };

  return {
    assertReady: verifyPin,
    scanText,
    scanPersistedDTO(value) {
      const strings = persistedStrings(value);
      const joined = strings.join("\n");
      return scanText(joined);
    },
  };
}

export type { SecretRuleId };
