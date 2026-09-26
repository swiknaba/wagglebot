import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// Install a complete local package with its external dependencies. Bun bundles workspace modules into dist.
export function installBuiltPackage(cwd: string, env: NodeJS.ProcessEnv, scratch: string): void {
  const stage = mkdtempSync(join(scratch, "package-"));
  const metadata = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  for (const path of ["bin", "dist", "templates", "README.md"])
    cpSync(join(cliDir, path), join(stage, path), { recursive: true });
  const dependencies = Object.fromEntries(
    Object.entries(metadata.dependencies as Record<string, string>).filter(
      ([, version]) => !version.startsWith("workspace:"),
    ),
  );
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({ ...metadata, dependencies, devDependencies: {}, bundledDependencies: Object.keys(dependencies) }),
  );
  const copyDependency = (name: string, parent: string, destination: string): void => {
    const require = createRequire(join(parent, "package.json"));
    const source = dirname(require.resolve(`${name}/package.json`));
    const target = join(destination, "node_modules", name);
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) => !path.split("/").includes("node_modules", source.split("/").length),
    });
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) copyDependency(dependency, source, target);
  };
  for (const name of Object.keys(dependencies)) copyDependency(name, cliDir, stage);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
      cwd: stage,
      env,
      encoding: "utf8",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--package-lock=false",
      join(scratch, packed[0].filename),
    ],
    { cwd, env, encoding: "utf8" },
  );
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
