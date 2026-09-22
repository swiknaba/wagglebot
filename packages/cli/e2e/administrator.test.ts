import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, ensureBuilt, git, initGit, installBuiltPackage, isolatedEnv, repoRoot, runCli } from "./helper";

test("the documented administrator procedure installs the package and provisions a new scaffold offline", () => {
  ensureBuilt();
  const scratch = mkdtempSync(join(tmpdir(), "wagglebot-admin-"));
  const home = join(scratch, "home");
  const env = isolatedEnv(home);
  try {
    const doc = readFileSync(join(repoRoot, "docs/phase-1-onboarding.md"), "utf8");
    const commands = doc
      .split("## Administrator flow")[1]
      ?.match(/```sh\n([\s\S]*?)```/)?.[1]
      ?.trim()
      .split("\n");
    expect(commands).toBeDefined();
    let cwd = scratch;
    for (const command of commands ?? []) {
      if (command === "wagglebot init --wagglebot mycompany-wagglebot") {
        expect(runCli(["init", "--wagglebot", "mycompany-wagglebot"], { cwd, env }).status).toBe(0);
        // Keep curated network sources outside the offline procedure.
        writeFileSync(join(scratch, "mycompany-wagglebot/company/skills.list"), "");
      } else if (command === "cd mycompany-wagglebot") cwd = join(scratch, "mycompany-wagglebot");
      else if (command === "git init") {
        initGit(cwd, env);
        git(cwd, env, "config", "--global", "wagglebot.username", "alice");
      } else if (command === "npm install") installBuiltPackage(cwd, env, scratch);
      else if (command === "wagglebot update") {
        const result = runCli(["update"], { cwd, env });
        expect(result.status, result.stdout).toBe(0);
        expect(existsSync(join(cwd, "node_modules/wagglebot/bin/wagglebot.js"))).toBe(true);
        expect(existsSync(join(cwd, "node_modules/wagglebot/dist/index.js"))).toBe(true);
        expect(existsSync(join(home, ".zshenv"))).toBe(true);
      } else throw new Error(`Unrecognized administrator step: ${command}`);
    }
    const shellLoads = (value: string) =>
      execFileSync("bash", ["-c", '. "$HOME/.zshenv"; test "$FIXTURE_TOKEN" = "$1"', "fixture", value], { env });
    writeFileSync(join(cwd, ".env.credentials"), "FIXTURE_TOKEN=working-tree-fixture\n");
    expect(shellLoads("working-tree-fixture").length).toBe(0);
    commitAll(cwd, env);
    const version = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).dependencies.wagglebot;
    const runtime = join(home, ".wagglebot/runtime", version);
    mkdirSync(runtime, { recursive: true });
    installBuiltPackage(runtime, env, scratch);
    expect(runCli(["connect", cwd], { cwd: scratch, env }).status).toBe(0);
    expect(runCli(["update", "--wagglebot"], { cwd: scratch, env }).status).toBe(0);
    const active = join(home, ".wagglebot/company/active");
    writeFileSync(join(active, ".env.credentials"), "FIXTURE_TOKEN=cached-fixture\n");
    for (let i = 0; i < 2; i += 1) {
      const refresh = runCli(["update", "--wagglebot"], { cwd: scratch, env });
      expect(refresh.status, refresh.stdout).toBe(0);
      expect(shellLoads("cached-fixture").length).toBe(0);
      expect(existsSync(join(active, ".env.credentials"))).toBe(false);
      expect(refresh.stdout).not.toContain("cached-fixture");
    }
    expect(readFileSync(join(cwd, ".env.credentials"), "utf8")).toBe("FIXTURE_TOKEN=working-tree-fixture\n");
    expect(git(cwd, env, "status", "--porcelain")).toBe("");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
