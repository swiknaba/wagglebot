import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// packages/cli/e2e/helper.ts -> repo root is two levels up.
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const cliDir = join(repoRoot, "packages", "cli");
export const cliBin = join(cliDir, "bin", "wagglebot.js");

// Pass only runtime paths. Credentials and user-specific settings stay outside the fixture.
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    SHELL: "/bin/zsh",
    CI: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
}

export function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

export function initGit(cwd: string, env: NodeJS.ProcessEnv): void {
  git(cwd, env, "init", "-q");
  git(cwd, env, "config", "user.name", "Offline fixture");
  git(cwd, env, "config", "user.email", "fixture@example.invalid");
  git(cwd, env, "config", "commit.gpgsign", "false");
}

export function commitAll(cwd: string, env: NodeJS.ProcessEnv): void {
  git(cwd, env, "add", ".");
  git(cwd, env, "commit", "-qm", "Offline fixture");
}

export function snapshot(dir: string, ignored = new Set<string>()): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (root: string, prefix: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(root, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (statSync(path).isDirectory()) walk(path, `${relative}/`);
      else result[relative] = readFileSync(path).toString("base64");
    }
  };
  walk(dir, "");
  return result;
}

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

export type CliResult = { stdout: string; stderr: string; status: number };

export function runCli(args: string[], opts: ExecFileSyncOptions = {}): CliResult {
  try {
    const stdout = execFileSync("node", [cliBin, ...args], { encoding: "utf8", timeout: 60_000, ...opts });
    return { stdout: stdout.toString(), stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    return { stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "", status: err.status ?? 1 };
  }
}
