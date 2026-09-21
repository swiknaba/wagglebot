import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const packageRoot = mkdtempSync(join(tmpdir(), "wgl-runtime-package-"));
const scratch: string[] = [];
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

beforeAll(() => {
  execFileSync(
    process.execPath,
    ["build", join(import.meta.dir, "index.ts"), "--target=node", "--outdir", join(packageRoot, "dist")],
    {
      cwd: join(import.meta.dir, ".."),
    },
  );
  put(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  put(
    join(packageRoot, "bin/wagglebot.js"),
    'import { main } from "../dist/index.js"; if (process.argv.includes("--company-root")) process.stderr.write("pinned runtime stderr\\n"); process.exitCode = await main(process.argv.slice(2));\n',
  );
  cpSync(join(import.meta.dir, "../templates"), join(packageRoot, "templates"), { recursive: true });
});

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
afterAll(() => rmSync(packageRoot, { recursive: true, force: true }));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wgl-runtime-process-"));
  scratch.push(root);
  const home = join(root, "home");
  const source = join(root, "source");
  mkdirSync(home);
  mkdirSync(source);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    SHELL: "/bin/bash",
    WAGGLEBOT_COMPANY_REPOSITORY_URL: source,
  };
  put(join(source, "wagglebot.yaml"), "version: 1\nkind: company\n");
  put(join(source, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.2.3" } }));
  put(join(source, "company/instructions/base.md"), "Interactive fixture instructions.\n");
  execFileSync("git", ["init", "-q", source], { env });
  execFileSync("git", ["-C", source, "add", "."], { env });
  execFileSync(
    "git",
    ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "fixture"],
    { env },
  );
  const runtimeModules = join(home, ".wagglebot/runtime/1.2.3/node_modules");
  mkdirSync(runtimeModules, { recursive: true });
  symlinkSync(packageRoot, join(runtimeModules, "wagglebot"), "dir");
  const cache = join(home, ".wagglebot/company/active");
  return { root, home, source, env, cache };
}

function runInteractiveCli(args: string[], cwd: string, env: NodeJS.ProcessEnv, queuedInput = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn("node", [join(packageRoot, "bin/wagglebot.js"), ...args], {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answered = queuedInput;
    if (queuedInput) child.stdin.end("alice\n");
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, 3500);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (!answered && stdout.includes("Company Git username: ")) {
        answered = true;
        child.stdin.end("alice\n");
      }
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

for (const command of ["update", "sync-harnesses"]) {
  test(`real cached ${command} shows the username prompt before input, stores the answer, and prints output once`, async () => {
    const f = fixture();
    if (command !== "update") execFileSync("git", ["clone", "-q", f.source, f.cache], { env: f.env });
    const result = await runInteractiveCli([command, "--wagglebot"], f.home, f.env);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("pinned runtime stderr\n");
    expect(result.stdout.match(/Company Git username: /g)).toHaveLength(1);
    expect(result.stdout.match(/^installed \d.*$/gm)).toHaveLength(1);
    expect(execFileSync("git", ["config", "--global", "wagglebot.username"], { env: f.env, encoding: "utf8" })).toBe(
      "alice\n",
    );
    expect(readFileSync(join(f.home, ".codex/AGENTS.md"), "utf8")).toContain("Interactive fixture instructions.");
    expect(existsSync(join(f.cache, "node_modules"))).toBe(false);
  }, 10000);
}

test("a real stale-cache child accepts the username and preserves the failed exit status", async () => {
  const f = fixture();
  execFileSync("git", ["clone", "-q", f.source, f.cache], { env: f.env });
  f.env.WAGGLEBOT_COMPANY_REPOSITORY_URL = join(f.root, "missing-remote");
  const result = await runInteractiveCli(["update", "--wagglebot"], f.home, f.env, true);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("pinned runtime stderr\n");
  expect(result.stdout.match(/Company Git username: /g)).toHaveLength(1);
  expect(result.stdout.match(/^installed \d.*$/gm)).toHaveLength(1);
  expect(result.stdout).toContain("failed 1 [Company source]");
  expect(execFileSync("git", ["config", "--global", "wagglebot.username"], { env: f.env, encoding: "utf8" })).toBe(
    "alice\n",
  );
}, 10000);
