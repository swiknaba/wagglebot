import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Exec, realExec } from "./exec";
import { type CliDeps, main } from "./index";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");

function fixture(company = false) {
  const root = mkdtempSync(join(tmpdir(), "wgl-route-"));
  scratch.push(root);
  const cwd = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(cwd);
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", cwd], { env: gitEnv });
  if (company) {
    put(join(cwd, "wagglebot.yaml"), "version: 1\nkind: company\n");
    put(join(cwd, "package.json"), JSON.stringify({ dependencies: { wagglebot: "9.8.7" } }));
    put(join(cwd, "company/instructions/base.md"), "Company source from the working tree.\n");
    put(join(cwd, "company/agents/reviewer.md"), "# Reviewer\n");
    put(
      join(cwd, "company/registry.yaml"),
      "proxies:\n  - namespace: fixture\n    mode: stdio_cmd\n    command: fixture-server\n",
    );
    put(join(cwd, "node_modules/wagglebot/templates/shell/wagglebot.sh"), "# fixture shell\n");
    put(join(cwd, ".gitignore"), "node_modules/\n");
  }
  const calls: { cmd: string; args: string[] }[] = [];
  const lines: string[] = [];
  const deps: CliDeps = {
    cwd,
    home,
    env: { SHELL: "/bin/zsh" },
    write: (line) => lines.push(line),
    ask: async () => {
      throw new Error("Unexpected identity prompt");
    },
    skillsBin: join(root, "offline-skills.js"),
    packageMetadata: { version: "1.2.3" },
  };
  const exec: Exec = async (cmd, args, options) => {
    calls.push({ cmd, args });
    if (cmd === "git" && args[0] === "config") return { code: 0, stdout: "alice\n", stderr: "" };
    if (cmd === "git" && args[0] === "clone") {
      if (!args[3]?.startsWith(root)) throw new Error("Only local fixture remotes are allowed");
      return realExec(cmd, args, { ...options, env: gitEnv });
    }
    if (cmd === "npm") {
      const prefix = args[args.indexOf("--prefix") + 1];
      if (!prefix) throw new Error("Missing runtime prefix");
      put(join(prefix, "node_modules/wagglebot/bin/wagglebot.js"), "// offline runtime\n");
      put(
        join(prefix, "node_modules/wagglebot/templates/shell/wagglebot.sh"),
        `export FIXTURE_PINNED_SHELL=loaded\n${read(join(import.meta.dir, "../templates/shell/wagglebot.sh"))}`,
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === process.execPath && args[0] === deps.skillsBin)
      return { code: 0, stdout: args[1] === "ls" ? "[]" : "", stderr: "" };
    if (cmd === process.execPath && args[0]?.endsWith("/bin/wagglebot.js")) {
      const child: string[] = [];
      const code = await main(args.slice(1), { ...deps, write: (line) => child.push(line) });
      return { code, stdout: child.join("\n"), stderr: "child stderr sentinel" };
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
  };
  deps.exec = exec;
  deps.runtimeExec = async (cmd, args) => {
    const result = await (deps.exec ?? exec)(cmd, args);
    if (result.stdout !== "") deps.write(result.stdout);
    if (result.stderr !== "") deps.write(result.stderr);
    return result.code;
  };
  const remote = () => {
    execFileSync("git", ["-C", cwd, "add", "."], { env: gitEnv });
    execFileSync(
      "git",
      ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "fixture"],
      { env: gitEnv },
    );
    return cwd;
  };
  return {
    root,
    cwd,
    home,
    calls,
    lines,
    deps,
    remote,
    gitEnv,
    output: () => lines.join("\n"),
    run: (args: string[]) => main(args, deps),
  };
}

test("connect works outside Git and stores only the explicit repository URL", async () => {
  const f = fixture();
  f.deps.cwd = f.home;
  expect(await f.run(["connect", "git@internal.local:company.git"])).toBe(0);
  expect(JSON.parse(read(join(f.home, ".wagglebot/config.json")))).toEqual({
    companyRepository: "git@internal.local:company.git",
  });
  expect(f.calls).toEqual([]);
});
for (const url of ["company.example:platform/company.git", "https://user:secret@git.internal/company.git"]) {
  for (const source of ["environment", "saved", "package"]) {
    test(`cached update rejects unsafe ${source} URL before Git (${url.split(":")[0]})`, async () => {
      const f = fixture();
      if (source === "environment") f.deps.env = { WAGGLEBOT_COMPANY_REPOSITORY_URL: url };
      if (source === "saved") put(join(f.home, ".wagglebot/config.json"), JSON.stringify({ companyRepository: url }));
      if (source === "package") f.deps.packageMetadata = { version: "1.2.3", wagglebot: { companyRepository: url } };
      expect(await f.run(["update", "--wagglebot"])).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.output()).not.toContain("user:secret");
    });
  }
}

for (const company of [false, true]) {
  test(`plain init initializes project files in ${company ? "company" : "project"} mode`, async () => {
    const f = fixture(company);
    put(join(f.cwd, ".agents/instructions/project.md"), "Project instruction.\n");
    expect(await f.run(["init"])).toBe(0);
    expect(read(join(f.cwd, "AGENTS.md"))).toContain("Project instruction.");
    expect(existsSync(join(f.cwd, ".agents/memory.md"))).toBe(true);
    expect(existsSync(join(f.cwd, ".agents/changelog.md"))).toBe(true);
    expect(existsSync(join(f.cwd, "catalog-info.yaml"))).toBe(false);
    expect(f.calls).toEqual([]);
  });
}

for (const directory of [undefined, "new-company"]) {
  test(`init --wagglebot scaffolds outside Git with ${directory ?? "the default directory"}`, async () => {
    const f = fixture();
    const target = join(f.root, "empty");
    mkdirSync(target);
    f.deps.cwd = target;
    expect(await f.run(["init", "--wagglebot", ...(directory ? [directory] : [])])).toBe(0);
    expect(read(join(target, directory ?? ".", "wagglebot.yaml"))).toBe("version: 1\nkind: company\n");
  });
}

for (const command of ["update", "sync-project"]) {
  test(`${command} publishes project instructions without company dependencies`, async () => {
    const f = fixture();
    put(join(f.cwd, ".agents/instructions/project.md"), "Project content.\n");
    expect(await f.run([command])).toBe(0);
    expect(read(join(f.cwd, "AGENTS.md"))).toContain("Project content.");
    expect(f.calls).toEqual([]);
  });
  test(`${command} rejects project overwrite before any file write`, async () => {
    const f = fixture();
    expect(await f.run([command, "--overwrite-local"])).toBe(1);
    expect(f.output()).toContain("project mode");
    expect(existsSync(join(f.cwd, ".agents"))).toBe(false);
  });
}

test("plain company update uses uncommitted changes in the current process and emits one summary", async () => {
  const f = fixture(true);
  f.remote();
  put(join(f.cwd, "company/instructions/base.md"), "Uncommitted company instruction.\n");
  expect(await f.run(["update"])).toBe(0);
  expect(read(join(f.home, ".codex/AGENTS.md"))).toContain("Uncommitted company instruction.");
  expect(f.calls.every((call) => call.cmd === "git" && call.args[0] === "config")).toBe(true);
  expect(f.output().match(/^installed \d.*$/gm)).toHaveLength(1);
});

test("company overwrite replaces personal instructions and creates no backup", async () => {
  const f = fixture(true);
  put(join(f.home, ".codex/AGENTS.md"), "Personal instruction.\n");
  expect(await f.run(["update", "--overwrite-local"])).toBe(0);
  expect(read(join(f.home, ".codex/AGENTS.md"))).not.toContain("Personal instruction.");
  expect(existsSync(join(f.home, ".wagglebot/backups"))).toBe(false);
});

const lowerCommands = ["install-skills", "install-agents", "sync-harnesses", "sync-shell", "write-mcp"];
for (const command of lowerCommands) {
  test(`${command} requires explicit company selection outside a marked working tree`, async () => {
    const f = fixture();
    expect(await f.run([command])).toBe(1);
    expect(f.output()).toContain("--wagglebot");
    expect(f.calls).toEqual([]);
  });
  test(`${command} --wagglebot requires an active cache`, async () => {
    const f = fixture();
    f.deps.cwd = f.home;
    expect(await f.run([command, "--wagglebot"])).toBe(1);
    expect(f.output()).toContain("wagglebot update --wagglebot");
    expect(f.calls).toEqual([]);
  });
}

for (const command of [...lowerCommands, "sync-agents"]) {
  test(`${command} selects the company working tree without a catalog or runtime install`, async () => {
    const f = fixture(true);
    expect(await f.run([command])).toBe(0);
    expect(f.calls.every((call) => call.cmd === "git" && call.args[0] === "config")).toBe(true);
    if (command === "sync-harnesses" || command === "sync-agents")
      expect(read(join(f.home, ".codex/AGENTS.md"))).toContain("Company source");
    if (command === "sync-shell") expect(read(join(f.home, ".zshenv"))).toContain(f.cwd);
    if (command === "install-agents")
      expect(read(join(f.home, ".claude/agents/company__reviewer.md"))).toContain("Reviewer");
    if (command === "write-mcp") expect(existsSync(join(f.home, ".claude.json"))).toBe(true);
  });
}

for (const source of ["environment", "saved", "package"]) {
  test(`cached update resolves the ${source} URL and refreshes before one pinned execution`, async () => {
    const f = fixture(true);
    const url = f.remote();
    f.deps.cwd = f.home;
    f.deps.packageMetadata = {
      version: "1.2.3",
      wagglebot: { companyRepository: source === "package" ? url : `${f.root}/unused-package` },
    };
    if (source !== "package")
      put(
        join(f.home, ".wagglebot/config.json"),
        JSON.stringify({ companyRepository: source === "saved" ? url : `${f.root}/unused-saved` }),
      );
    if (source === "environment") f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: url };
    expect(await f.run(["update", "--wagglebot"])).toBe(0);
    expect(f.calls[0]?.args.slice(0, 4)).toEqual(["clone", "--depth", "1", url]);
    expect(f.calls[1]?.args.at(-1)).toBe("wagglebot@9.8.7");
    const children = f.calls.filter((call) => call.args[0]?.endsWith("/bin/wagglebot.js"));
    expect(children).toHaveLength(1);
    expect(children[0]?.args).toContain("--company-root");
    expect(children[0]?.args).toContain("--pinned-runtime");
    expect(f.output()).toContain("child stderr sentinel");
    expect(f.output().match(/^installed \d.*$/gm)).toHaveLength(1);
    expect(read(join(f.home, ".codex/AGENTS.md"))).toContain("Company source");
  });
}

test("reserved example URLs never reach Git", async () => {
  const f = fixture();
  f.deps.packageMetadata = { version: "1.2.3", wagglebot: { companyRepository: "git@company.example:repo.git" } };
  expect(await f.run(["update", "--wagglebot"])).toBe(1);
  expect(f.output()).toContain("wagglebot connect");
  expect(f.calls).toEqual([]);
});

test("a failed first refresh performs no runtime installation or provisioning", async () => {
  const f = fixture();
  f.deps.env = { WAGGLEBOT_COMPANY_REPOSITORY_URL: join(f.root, "missing-remote") };
  expect(await f.run(["update", "--wagglebot"])).toBe(1);
  expect(f.output()).toContain("company refresh failed");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.args[0]).toBe("clone");
  expect(existsSync(join(f.home, ".codex"))).toBe(false);
});

test("a failed runtime installation stops before company provisioning", async () => {
  const f = fixture(true);
  f.deps.env = { WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  const exec = f.deps.exec;
  if (!exec) throw new Error("Missing fixture executor");
  f.deps.exec = (cmd, args, options) =>
    cmd === "npm" ? Promise.resolve({ code: 1, stdout: "", stderr: "fixture npm failure" }) : exec(cmd, args, options);
  expect(await f.run(["update", "--wagglebot"])).toBe(1);
  expect(f.output()).toContain("fixture npm failure");
  expect(existsSync(join(f.home, ".codex"))).toBe(false);
});

test("cached routing forwards a pinned child failure code and both output streams", async () => {
  const f = fixture(true);
  f.deps.env = { WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  const exec = f.deps.exec;
  if (!exec) throw new Error("Missing fixture executor");
  f.deps.exec = (cmd, args, options) =>
    cmd === process.execPath
      ? Promise.resolve({ code: 7, stdout: "child output", stderr: "child failure" })
      : exec(cmd, args, options);
  expect(await f.run(["update", "--wagglebot"])).toBe(7);
  expect(f.output()).toContain("child output");
  expect(f.output()).toContain("child failure");
  expect(existsSync(join(f.home, ".codex"))).toBe(false);
});

test("project init rejects overwrite before it creates project files", async () => {
  const f = fixture();
  expect(await f.run(["init", "--overwrite-local"])).toBe(1);
  expect(f.output()).toContain("project mode");
  expect(existsSync(join(f.cwd, ".agents"))).toBe(false);
});

for (const hidden of [false, true]) {
  test(`skill pin updates reject ${hidden ? "hidden runtime" : "explicit cached"} mode before a launch or mutation`, async () => {
    const f = fixture(true);
    put(join(f.cwd, "company/skills.list"), "acme/skills@v1.0.0\n");
    const active = join(f.home, ".wagglebot/company/active");
    execFileSync("git", ["clone", "-q", f.remote(), active], { env: f.gitEnv });
    const exec = f.deps.exec;
    if (!exec) throw new Error("Missing fixture executor");
    f.deps.exec = (cmd, args, options) =>
      cmd === "git" && args[0] === "ls-remote"
        ? Promise.resolve({ code: 0, stdout: "abc123\trefs/tags/v2.0.0\n", stderr: "" })
        : exec(cmd, args, options);
    const before = read(join(active, "company/skills.list"));
    const code = await f.run(
      hidden
        ? ["--company-root", active, "--pinned-runtime", "9.8.7", "install-skills", "--update"]
        : ["install-skills", "--wagglebot", "--update"],
    );
    expect(read(join(active, "company/skills.list"))).toBe(before);
    expect(code).toBe(1);
    expect(f.output()).toContain("marked company working tree");
    expect(f.calls).toEqual([]);
  });
}

test("skill pin updates remain available in a marked company working tree", async () => {
  const f = fixture(true);
  put(join(f.cwd, "company/skills.list"), "acme/skills@v1.0.0\n");
  const exec = f.deps.exec;
  if (!exec) throw new Error("Missing fixture executor");
  f.deps.exec = (cmd, args, options) =>
    cmd === "git" && args[0] === "ls-remote"
      ? Promise.resolve({ code: 0, stdout: "abc123\trefs/tags/v2.0.0\n", stderr: "" })
      : exec(cmd, args, options);
  expect(await f.run(["install-skills", "--update"])).toBe(0);
  expect(read(join(f.cwd, "company/skills.list"))).toBe("acme/skills@v2.0.0\n");
  expect(f.calls.every((call) => call.cmd === "git" && call.args[0] === "config")).toBe(true);
});
for (const resolved of [false, true]) {
  test(`plain skill pin updates reject the ${resolved ? "resolved revision" : "active symlink"} cache root`, async () => {
    const f = fixture(true);
    put(join(f.cwd, "company/skills.list"), "acme/skills@v1.0.0\n");
    f.deps.env = { WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
    expect(await f.run(["update", "--wagglebot"])).toBe(0);
    const active = join(f.home, ".wagglebot/company/active");
    f.deps.cwd = resolved ? realpathSync(active) : active;
    f.calls.length = 0;
    f.lines.length = 0;
    const exec = f.deps.exec;
    if (!exec) throw new Error("Missing fixture executor");
    f.deps.exec = (cmd, args, options) =>
      args[0] === "ls-remote"
        ? Promise.resolve({ code: 0, stdout: "abc\trefs/tags/v2.0.0\n", stderr: "" })
        : exec(cmd, args, options);
    expect(await f.run(["install-skills", "--update"])).toBe(1);
    expect(read(join(active, "company/skills.list"))).toBe("acme/skills@v1.0.0\n");
    expect(f.calls).toEqual([]);
    expect(f.output()).toContain("immutable");
  });
}

test("cached refresh migrates legacy personal credentials and retains them across later revisions", async () => {
  const f = fixture(true);
  f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  const active = join(f.home, ".wagglebot/company/active");
  const oldRevision = realpathSync(active);
  put(join(active, ".env.credentials"), "FIXTURE_TOKEN=synthetic-only\n");
  const credentialFile = join(f.home, ".wagglebot/.env.credentials");
  for (let i = 0; i < 2; i += 1) {
    expect(await f.run(["update", "--wagglebot"])).toBe(0);
    const result = execFileSync("bash", ["-c", '. "$HOME/.zshenv"; test "$FIXTURE_TOKEN" = synthetic-only'], {
      env: f.gitEnv,
    });
    expect(result.length).toBe(0);
    expect(existsSync(credentialFile)).toBe(true);
    expect(existsSync(join(active, ".env.credentials"))).toBe(false);
    expect(read(join(f.home, ".zshenv"))).not.toContain("synthetic-only");
    expect(f.output()).not.toContain("synthetic-only");
  }
  expect(existsSync(join(oldRevision, ".env.credentials"))).toBe(false);
});

for (const failure of ["npm", "child", "shell", "catalog", "later-mcp"]) {
  test(`credential migration preserves shell loads across ${failure} failure and retry`, async () => {
    const f = fixture(true);
    f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
    expect(await f.run(["update", "--wagglebot"])).toBe(0);
    const active = join(f.home, ".wagglebot/company/active");
    const oldRevision = realpathSync(active);
    put(join(active, ".env.credentials"), "FIXTURE_TOKEN=synthetic-only\n");
    // This is the pre-migration loading contract. It does not know the stable credential path.
    put(
      join(f.home, ".zshenv"),
      `# wagglebot:begin\nexport WAGGLEBOT_COMPANY_REPO="${active}"\n[ -r "$WAGGLEBOT_COMPANY_REPO/.env.credentials" ] && . "$WAGGLEBOT_COMPANY_REPO/.env.credentials"\n# wagglebot:end\n`,
    );
    const loadShell = () =>
      execFileSync("bash", ["-c", '. "$HOME/.zshenv"; test "$FIXTURE_TOKEN" = synthetic-only'], {
        env: { HOME: f.home },
      });
    expect(loadShell().length).toBe(0);
    put(join(f.cwd, "package.json"), JSON.stringify({ dependencies: { wagglebot: "9.8.8" } }));
    if (failure === "later-mcp") put(join(f.cwd, "company/registry.yaml"), "proxies: [invalid\n");
    if (failure === "catalog") put(join(f.cwd, "company/catalog.yaml"), "invalid: [\n");
    f.remote();
    const exec = f.deps.exec;
    const runtimeExec = f.deps.runtimeExec;
    if (!exec) throw new Error("Missing fixture executor");
    if (failure === "npm")
      f.deps.exec = (cmd, args, options) =>
        cmd === "npm"
          ? Promise.resolve({ code: 1, stdout: "", stderr: "fixture npm failure" })
          : exec(cmd, args, options);
    if (failure === "child") f.deps.runtimeExec = async () => 7;
    if (failure === "shell") mkdirSync(join(f.home, ".bashrc"));
    expect(await f.run(["update", "--wagglebot"])).toBe(failure === "child" ? 7 : 1);
    expect(loadShell().length).toBe(0);
    const shellFailed = !["catalog", "later-mcp"].includes(failure);
    expect(existsSync(join(oldRevision, ".env.credentials"))).toBe(shellFailed);
    expect(realpathSync(active) === oldRevision).toBe(shellFailed);
    f.deps.exec = exec;
    f.deps.runtimeExec = runtimeExec;
    if (failure === "shell") rmSync(join(f.home, ".bashrc"), { recursive: true });
    if (failure === "later-mcp") {
      put(join(f.cwd, "company/registry.yaml"), "proxies: []\n");
      f.remote();
    }
    if (failure === "catalog") {
      put(join(f.cwd, "company/catalog.yaml"), "");
      f.remote();
    }
    expect(await f.run(["update", "--wagglebot"])).toBe(0);
    expect(loadShell().length).toBe(0);
    expect(existsSync(join(oldRevision, ".env.credentials"))).toBe(false);
    expect(realpathSync(active)).not.toBe(oldRevision);
    expect(f.output()).not.toContain("synthetic-only");
  });
}

test("a separate stable credential file does not disconnect the legacy shell on npm failure", async () => {
  const f = fixture(true);
  f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  const active = join(f.home, ".wagglebot/company/active");
  const previous = realpathSync(active);
  put(join(active, ".env.credentials"), "FIXTURE_TOKEN=legacy-only\n");
  put(join(f.home, ".wagglebot/.env.credentials"), "FIXTURE_TOKEN=stable-only\n");
  put(join(f.home, ".zshenv"), `# wagglebot:begin\n. "${active}/.env.credentials"\n# wagglebot:end\n`);
  const load = (value: string) =>
    execFileSync("bash", ["-c", '. "$HOME/.zshenv"; test "$FIXTURE_TOKEN" = "$1"', "fixture", value], {
      env: { HOME: f.home },
    });
  expect(load("legacy-only").length).toBe(0);
  put(join(f.cwd, "package.json"), JSON.stringify({ dependencies: { wagglebot: "9.8.8" } }));
  f.remote();
  const exec = f.deps.exec;
  if (!exec) throw new Error("Missing fixture executor");
  f.deps.exec = (cmd, args, options) =>
    cmd === "npm" ? Promise.resolve({ code: 1, stdout: "", stderr: "fixture npm failure" }) : exec(cmd, args, options);
  expect(await f.run(["update", "--wagglebot"])).toBe(1);
  expect(load("legacy-only").length).toBe(0);
  expect(realpathSync(active)).toBe(previous);
  f.deps.exec = exec;
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  expect(load("stable-only").length).toBe(0);
  expect(existsSync(join(previous, ".env.credentials"))).toBe(true);
});

test("cached update repairs a write-only shell receipt before credential settlement", async () => {
  const f = fixture(true);
  f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  const active = join(f.home, ".wagglebot/company/active");
  const previous = realpathSync(active);
  put(join(active, ".env.credentials"), "FIXTURE_TOKEN=synthetic-only\n");
  const receipt = join(f.home, ".wagglebot/company-shell-ready");
  chmodSync(receipt, 0o200);
  f.lines.length = 0;
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  expect(realpathSync(active)).not.toBe(previous);
  expect(lstatSync(receipt).mode & 0o777).toBe(0o600);
  expect(read(receipt)).toBe(realpathSync(active));
  expect(existsSync(join(previous, ".env.credentials"))).toBe(false);
  expect(
    execFileSync("bash", ["-c", '. "$HOME/.zshenv"; test "$FIXTURE_TOKEN" = synthetic-only'], { env: { HOME: f.home } })
      .length,
  ).toBe(0);
  expect(f.output()).not.toContain("rolled back");
});

for (const receiptFailure of ["unreadable", "symlink", "rollback-failure"]) {
  for (const childCode of [0, 7]) {
    test(`credential settlement reports ${receiptFailure} after child exit ${childCode}`, async () => {
      const f = fixture(true);
      f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
      expect(await f.run(["update", "--wagglebot"])).toBe(0);
      const active = join(f.home, ".wagglebot/company/active");
      const previous = realpathSync(active);
      put(join(active, ".env.credentials"), "FIXTURE_TOKEN=synthetic-only\n");
      const receipt = join(f.home, ".wagglebot/company-shell-ready");
      const runtimeExec = f.deps.runtimeExec;
      if (!runtimeExec) throw new Error("Missing fixture runtime executor");
      f.deps.runtimeExec = async (cmd, args) => {
        expect(await runtimeExec(cmd, args)).toBe(0);
        if (receiptFailure === "unreadable") chmodSync(receipt, 0o200);
        else {
          unlinkSync(receipt);
          if (receiptFailure === "symlink") {
            const target = join(f.home, "receipt-target");
            put(target, realpathSync(active));
            symlinkSync(target, receipt);
          } else {
            unlinkSync(active);
            symlinkSync(previous, active, "dir");
          }
        }
        return childCode;
      };
      f.lines.length = 0;
      expect(await f.run(["update", "--wagglebot"])).toBe(childCode || 1);
      expect(f.output()).toContain("Credential migration failed");
      expect(f.output()).not.toContain("synthetic-only");
      expect(f.output().match(/^installed \d+.*failed \d+.*$/gm)).toHaveLength(1);
      expect(realpathSync(active)).toBe(previous);
      expect(existsSync(join(previous, ".env.credentials"))).toBe(true);
      expect(
        execFileSync("bash", ["-c", '. "$HOME/.zshenv"; test "$FIXTURE_TOKEN" = synthetic-only'], {
          env: { HOME: f.home },
        }).length,
      ).toBe(0);
    });
  }
}

test("failed refresh provisions stale cache through the pinned child and preserves failure in its summary", async () => {
  const f = fixture(true);
  f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  f.calls.length = 0;
  f.lines.length = 0;
  f.deps.env.WAGGLEBOT_COMPANY_REPOSITORY_URL = join(f.root, "missing-remote");
  put(join(f.home, ".codex/AGENTS.md"), "Personal preamble.\n");
  expect(await f.run(["update", "--wagglebot"])).toBe(1);
  expect(read(join(f.home, ".codex/AGENTS.md"))).toContain("Company source");
  expect(f.calls.find((call) => call.cmd === process.execPath)?.args).toContain("--source-failed");
  expect(f.calls.some((call) => call.cmd === "npm")).toBe(false);
  expect(f.output()).toContain("company refresh failed");
  expect(f.output()).toContain("Company source");
  expect(f.output().match(/^installed \d.*$/gm)).toHaveLength(1);
  expect(f.output()).toContain("failed 1");
});

for (const command of lowerCommands) {
  test(`${command} --wagglebot selects the active cache pin without a refresh`, async () => {
    const f = fixture(true);
    const active = join(f.home, ".wagglebot/company/active");
    // The cache root is an already validated local fixture for this route.
    execFileSync("git", ["clone", "-q", f.remote(), active], { env: f.gitEnv });
    f.deps.cwd = f.home;
    expect(await f.run([command, "--wagglebot"])).toBe(0);
    expect(f.calls[0]?.cmd).toBe("npm");
    expect(f.calls[0]?.args.at(-1)).toBe("wagglebot@9.8.7");
    expect(f.calls.filter((call) => call.args[0]?.endsWith("/bin/wagglebot.js"))).toHaveLength(1);
    expect(f.calls.some((call) => call.cmd === "git" && call.args[0] !== "config")).toBe(false);
  });
}

test("hidden root skips bootstrap and keeps stale-source failure after provisioning", async () => {
  const f = fixture(true);
  f.deps.cwd = f.home;
  put(
    join(f.home, ".wagglebot/runtime/9.8.7/node_modules/wagglebot/templates/shell/wagglebot.sh"),
    "# fixture shell\n",
  );
  expect(
    await f.run(["--company-root", f.cwd, "--pinned-runtime", "9.8.7", "--source-failed", "update", "--wagglebot"]),
  ).toBe(1);
  expect(read(join(f.home, ".codex/AGENTS.md"))).toContain("Company source");
  expect(f.calls.every((call) => call.cmd === "git" && call.args[0] === "config")).toBe(true);
  expect(f.output().match(/^installed \d.*$/gm)).toHaveLength(1);
  expect(f.output()).toContain("failed 1 [Company source]");
});

test("an equals-form hidden root provisions directly without runtime selection", async () => {
  const f = fixture(true);
  f.deps.cwd = f.home;
  expect(await f.run(["update", `--company-root=${f.cwd}`])).toBe(0);
  expect(read(join(f.home, ".codex/AGENTS.md"))).toContain("Company source");
  expect(f.calls.every((call) => call.cmd === "git" && call.args[0] === "config")).toBe(true);
});

test("hidden root must pass base validation before provisioning", async () => {
  const f = fixture();
  expect(await f.run(["--company-root", f.cwd, "--pinned-runtime", "9.8.7", "update"])).toBe(1);
  expect(f.output()).toContain("wagglebot.yaml");
  expect(f.calls).toEqual([]);
});

test("cached overwrite survives pinned re-execution", async () => {
  const f = fixture(true);
  f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  put(join(f.home, ".codex/AGENTS.md"), "Personal instruction.\n");
  expect(await f.run(["update", "--wagglebot", "--overwrite-local"])).toBe(0);
  expect(read(join(f.home, ".codex/AGENTS.md"))).not.toContain("Personal instruction.");
  expect(f.calls.find((call) => call.args[0]?.endsWith("/bin/wagglebot.js"))?.args).toContain("--overwrite-local");
  expect(existsSync(join(f.home, ".wagglebot/backups"))).toBe(false);
});

test("cached shell uses the pinned package and keeps the active cache as its company root", async () => {
  const f = fixture(true);
  f.deps.env = { SHELL: "/bin/zsh", WAGGLEBOT_COMPANY_REPOSITORY_URL: f.remote() };
  expect(await f.run(["update", "--wagglebot"])).toBe(0);
  const active = join(f.home, ".wagglebot/company/active");
  const shell = read(join(f.home, ".zshenv"));
  expect(shell).toContain(join(f.home, ".wagglebot/runtime/9.8.7/node_modules/wagglebot/templates/shell/wagglebot.sh"));
  expect(shell).toContain(`WAGGLEBOT_COMPANY_REPO="${active}"`);
  expect(existsSync(join(active, "node_modules"))).toBe(false);
  const loaded = execFileSync("bash", ["-c", '. "$HOME/.zshenv"; printf "%s" "$FIXTURE_PINNED_SHELL"'], {
    env: { ...f.gitEnv, HOME: f.home },
    encoding: "utf8",
  });
  expect(loaded).toBe("loaded");
});

test("--version prints the package version and exits 0", async () => {
  const lines: string[] = [];
  const code = await main(["--version"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines[0]).toMatch(/^\d+\.\d+\.\d+$/);
});

test("an unknown command exits 2 and names the command", async () => {
  const lines: string[] = [];
  const code = await main(["bogus"], { write: (l) => lines.push(l) });
  expect(code).toBe(2);
  expect(lines.join("\n")).toContain("bogus");
});

test("--help lists every command and the user git config key", async () => {
  const lines: string[] = [];
  const code = await main(["--help"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  const text = lines.join("\n");
  for (const fragment of [
    "update",
    "init",
    "install-skills",
    "install-agents",
    "sync-harnesses",
    "connect",
    "sync-shell",
    "write-mcp",
    "wagglebot.username",
  ]) {
    expect(text).toContain(fragment);
  }
});

test("sync-project --help exits 0 and mentions AGENTS.md", async () => {
  const lines: string[] = [];
  const code = await main(["sync-project", "--help"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain("AGENTS.md");
});

test("sync-project outside a Git repository exits 1 and mentions Git repository", async () => {
  const noGit = mkdtempSync(join(tmpdir(), "wgl-noGit-"));
  const lines: string[] = [];
  const code = await main(["sync-project"], { write: (l) => lines.push(l), cwd: noGit });
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("Git repository");
});

test("update --help prints the same help", async () => {
  const lines: string[] = [];
  expect(await main(["update", "--help"], { write: (l) => lines.push(l) })).toBe(0);
  expect(lines.join("\n")).toContain("managed");
});

test("write-mcp --help names the MCP config file it writes", async () => {
  const lines: string[] = [];
  const code = await main(["write-mcp", "--help"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain("~/.claude.json");
});

test("an unknown command with --help still exits 2, not 0", async () => {
  const lines: string[] = [];
  const code = await main(["bogus", "--help"], { write: (l) => lines.push(l) });
  expect(code).toBe(2);
  expect(lines.join("\n")).toContain("unknown command");
});

test("update outside a company repo fails cleanly with guidance, no thrown stack trace", async () => {
  const deep = mkdtempSync(join(tmpdir(), "wgl-deep-"));
  const nested = join(deep, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  const lines: string[] = [];
  const code = await main(["update"], { write: (l) => lines.push(l), cwd: nested });
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("Git repository");
});
