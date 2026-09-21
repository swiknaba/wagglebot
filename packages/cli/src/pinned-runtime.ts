import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";

export type PinnedRuntime = { version: string; bin: string };

const binFor = (root: string): string => join(root, "node_modules", "wagglebot", "bin", "wagglebot.js");

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const completeRuntime = (root: string): boolean => {
  const bin = binFor(root);
  try {
    return statSync(bin).isFile();
  } catch {
    return false;
  }
};

const errorDetail = (result: { stderr: string; stdout: string; notFound?: true }): string => {
  if (result.notFound === true) return "npm is not installed";
  return result.stderr.trim() || result.stdout.trim() || "npm install failed";
};

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const RESERVED_VALUE_OPTIONS = new Set(["--company-root", "--pinned-runtime"]);
const RESERVED_OPTIONS = new Set(["--company-root", "--pinned-runtime", "--source-failed"]);

const removeReservedArguments = (argv: string[]): string[] => {
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (RESERVED_VALUE_OPTIONS.has(argument)) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("-")) index += 1;
      continue;
    }
    if (RESERVED_OPTIONS.has(argument) || [...RESERVED_OPTIONS].some((option) => argument.startsWith(`${option}=`))) {
      continue;
    }
    filtered.push(argument);
  }
  return filtered;
};

export async function ensurePinnedRuntime(input: {
  pin: string;
  runtimeDir: string;
  exec: Exec;
}): Promise<PinnedRuntime> {
  const versionDir = join(input.runtimeDir, input.pin);
  const bin = binFor(versionDir);
  if (completeRuntime(versionDir)) return { version: input.pin, bin };

  mkdirSync(input.runtimeDir, { recursive: true });
  const candidateRuntime = join(input.runtimeDir, `.${input.pin}.${randomUUID()}`);
  let activated = false;
  try {
    mkdirSync(candidateRuntime);
    const install = await input.exec("npm", [
      "install",
      "--prefix",
      candidateRuntime,
      "--no-save",
      "--no-package-lock",
      `wagglebot@${input.pin}`,
    ]);
    if (install.code !== 0) throw new Error(`pinned runtime install failed: ${errorDetail(install)}`);
    if (!completeRuntime(candidateRuntime)) {
      throw new Error("pinned runtime install produced an incomplete package");
    }

    const displacedRuntime = `${versionDir}.stale-${randomUUID()}`;
    const hadVersionDir = pathExists(versionDir);
    if (hadVersionDir) renameSync(versionDir, displacedRuntime);
    try {
      renameSync(candidateRuntime, versionDir);
      activated = true;
    } catch (error) {
      if (hadVersionDir && !pathExists(versionDir)) renameSync(displacedRuntime, versionDir);
      throw error;
    }
    if (hadVersionDir) rmSync(displacedRuntime, { recursive: true, force: true });
    return { version: input.pin, bin };
  } catch (error) {
    if (!activated) rmSync(candidateRuntime, { recursive: true, force: true });
    throw asError(error);
  }
}

export async function runPinnedRuntime(input: {
  runtime: PinnedRuntime;
  argv: string[];
  companyRoot: string;
  sourceFailed?: boolean;
  exec: Exec;
  write: (line: string) => void;
}): Promise<number> {
  const hiddenArgs = ["--company-root", input.companyRoot, "--pinned-runtime", input.runtime.version];
  if (input.sourceFailed === true) hiddenArgs.push("--source-failed");
  const result = await input.exec(process.execPath, [
    input.runtime.bin,
    ...hiddenArgs,
    ...removeReservedArguments(input.argv),
  ]);
  if (result.stdout !== "") input.write(result.stdout);
  if (result.stderr !== "") input.write(result.stderr);
  return result.code;
}
