import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// packages/cli/e2e/helper.ts -> repo root is two levels up.
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const cliDir = join(repoRoot, "packages", "cli");
export const cliBin = join(cliDir, "bin", "wagglebot.js");

// The e2e tests exercise the real, built CLI (dist/index.js), not the TS sources. Rebuilds
// unconditionally — a stale dist/ must never mask a source edit — but only once per test
// process (the build takes well under a second, so a single rebuild stays cheap while a
// module-level flag stops every test file that calls this from rebuilding again).
let built = false;
export function ensureBuilt(): void {
  if (built) return;
  execFileSync("bun", ["run", "build"], { cwd: cliDir, stdio: "inherit" });
  built = true;
}

export type CliResult = { stdout: string; status: number };

export function runCli(args: string[], opts: ExecFileSyncOptions = {}): CliResult {
  try {
    const stdout = execFileSync("node", [cliBin, ...args], { encoding: "utf8", ...opts });
    return { stdout: stdout.toString(), status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; status?: number | null };
    return { stdout: err.stdout?.toString() ?? "", status: err.status ?? 1 };
  }
}
