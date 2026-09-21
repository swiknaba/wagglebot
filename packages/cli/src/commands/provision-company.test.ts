import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestBackupSet, restoreSet } from "../backup";
import type { Exec } from "../exec";
import { resolvePaths } from "../paths";
import { createReporter } from "../report";
import { loadState } from "../state";
import { runCompanyProvision, runUpdate } from "./provision-company";

const provision = async (
  root: string,
  home: string,
  options: { exec?: Exec; overwriteLocal?: boolean; sourceFailed?: boolean } = {},
) => {
  const lines: string[] = [];
  const summaries: string[] = [];
  const reporter = createReporter((line) => lines.push(line), false);
  const code = await runCompanyProvision({
    companyRoot: root,
    home,
    exec: options.exec ?? gitExec([]),
    ask: async () => "alice",
    reporter,
    write: (line) => {
      summaries.push(line);
      lines.push(line);
    },
    skillsBin: "/bin/skills",
    env: { SHELL: "/bin/zsh", TOKEN: "secret-sentinel" },
    ...options,
  });
  return { code, lines, summaries, reporter };
};

test("company provisioning runs all stages in order and prints one named summary", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  writeFileSync(join(root, "company/skills.list"), "acme/skills\n");
  const { code, lines, summaries } = await provision(root, home);
  expect(code).toBe(0);
  const sections = ["Skills", "Custom agents", "Base template sync", "Shell environment", "MCP configs"].map((name) =>
    lines.indexOf(`== ${name} ==`),
  );
  expect(sections.every((index, i) => index >= 0 && (i === 0 || index > (sections[i - 1] ?? -1)))).toBe(true);
  expect(summaries).toHaveLength(1);
  for (const status of ["ok", "updated", "skipped", "warned", "failed"]) expect(summaries[0]).toContain(`${status} `);
  expect(summaries[0]).toContain("acme/skills");
  expect(summaries[0]).toContain(".zshenv");
  expect(lines.at(-1)).toBe(summaries[0] ?? "");
});

test("the single final summary includes earlier reporter items and warnings", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const summaries: string[] = [];
  const reporter = createReporter(() => {}, false);
  reporter.item("Earlier failure", "failed");
  reporter.item("Earlier skip", "skipped");
  reporter.item("Earlier success", "ok");
  reporter.item("Earlier update", "updated");
  reporter.warn("Earlier warning");
  const code = await runCompanyProvision({
    companyRoot: root,
    home,
    exec: gitExec([]),
    ask: async () => "alice",
    reporter,
    write: (line) => summaries.push(line),
    env: zshEnv,
  });
  expect(code).toBe(1);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toContain("failed 1 [Earlier failure]");
  expect(summaries[0]).toContain("warned 1 [Earlier warning]");
  for (const status of ["ok", "updated", "skipped"] as const)
    expect(summaries[0]).toContain(`${status} ${reporter.counts()[status]} [`);
  for (const name of ["Earlier skip", "Earlier success", "Earlier update"]) expect(summaries[0]).toContain(name);
});

test("two consecutive provisioning runs report unchanged skills as ok", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  writeFileSync(join(root, "company/skills.list"), "acme/skills@v1.0.0\n");
  expect((await provision(root, home)).code).toBe(0);
  const owned = loadState(resolvePaths(home).managedFile).skills;
  const { code, lines } = await provision(root, home);
  expect(code).toBe(0);
  const skillItems = lines.filter((line) => /^ {2}(?:ok|updated|installed)\s+acme\/skills@v1\.0\.0/.test(line));
  expect(skillItems).toHaveLength(9);
  expect(skillItems.every((line) => /^ {2}ok\s/.test(line))).toBe(true);
  expect(loadState(resolvePaths(home).managedFile).skills).toEqual(owned);
});

for (const situation of ["stale runtime", "missing yarn", "failed pull", "failed yarn"]) {
  test(`legacy update includes its own items in one named summary: ${situation}`, async () => {
    const root = scaffoldCompany();
    const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
    const output: string[] = [];
    const reporter = createReporter(() => {}, false);
    if (situation === "stale runtime")
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.5.0" } }));
    const moving = pinMovingExec(root, []);
    const exec: Exec = async (cmd, args, opts) => {
      if (situation === "failed pull" && args[0] === "pull") return { code: 1, stdout: "", stderr: "Cannot refresh" };
      if (cmd === "yarn")
        return {
          code: 127,
          stdout: "",
          stderr: "Cannot install",
          notFound: situation === "missing yarn" ? true : undefined,
        };
      return situation === "stale runtime" ? gitExec([])(cmd, args, opts) : moving(cmd, args, opts);
    };
    const code = await runUpdate({
      cwd: root,
      home,
      exec,
      ask: async () => "alice",
      reporter,
      write: (line) => output.push(line),
      skillsBin: "/bin/skills",
      cliVersion: "1.4.2",
      env: zshEnv,
    });
    expect(code).toBe(situation.startsWith("failed") ? 1 : 0);
    const summaries = output.filter((line) => line.startsWith("installed "));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("warned 0");
    const name =
      situation === "stale runtime" ? "wagglebot" : situation === "failed pull" ? "git pull --ff-only" : "yarn install";
    expect(summaries[0]).toContain(name);
    if (situation.startsWith("failed")) expect(summaries[0]).toContain(`failed 1 [${name}]`);
    else expect(summaries[0]).toContain(`skipped ${reporter.counts().skipped} [`);
  });
}

for (const thrown of [false, true]) {
  test(`skills failure continues every stage (thrown: ${thrown})`, async () => {
    const root = scaffoldCompany();
    const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
    writeFileSync(join(root, "company/skills.list"), "acme/skills@v1.0.0\n");
    mkdirSync(join(root, "company/agents"));
    writeFileSync(join(root, "company/agents/reviewer.md"), "Review code.\n");
    const exec: Exec = async (cmd, args) => {
      if (cmd === "git") return { code: 0, stdout: "alice", stderr: "" };
      if (args.includes("claude-code")) {
        if (thrown) throw new Error("Skills failed");
        return { code: 1, stdout: "", stderr: "Skills failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const { code, lines, summaries } = await provision(root, home, { exec });
    expect(code).toBe(1);
    expect(existsSync(join(home, ".claude/agents/company__reviewer.md"))).toBe(true);
    expect(existsSync(join(home, ".cursor/rules/wagglebot.mdc"))).toBe(true);
    expect(existsSync(join(home, ".zshenv"))).toBe(true);
    expect(readFileSync(join(home, ".cursor/mcp.json"), "utf8")).toContain("https://ex/mcp");
    expect(lines).toContain("== MCP configs ==");
    expect(summaries).toHaveLength(1);
    expect(loadState(resolvePaths(home).managedFile).skills["acme/skills@v1.0.0"]).toContain("cursor");
  });
}

for (const invalid of ["kind: [", "kind: Group\nmetadata: { name: other }\n"]) {
  test(`invalid catalog continues company provisioning: ${invalid}`, async () => {
    const root = scaffoldCompany();
    writeFileSync(join(root, "teams/t/catalog.yaml"), invalid);
    writeFileSync(join(root, "company/instructions/base.md"), "Company base instruction.");
    mkdirSync(join(root, "teams/t/instructions"));
    writeFileSync(join(root, "teams/t/instructions/team.md"), "Team must not appear.");
    const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
    const { code, reporter, summaries } = await provision(root, home);
    expect(code).toBe(1);
    expect(reporter.counts().failed).toBe(1);
    const instructions = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
    expect(instructions).toContain("Company base instruction.");
    expect(instructions).not.toContain("Team must not appear.");
    expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(true);
    expect(summaries).toHaveLength(1);
  });
}

test("malformed targets do not block another harness or later stages", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/agents"), "Invalid directory");
  writeFileSync(join(home, ".claude/settings.json"), "{ invalid");
  writeFileSync(join(home, ".claude.json"), "{ invalid");
  mkdirSync(join(root, "company/agents"));
  writeFileSync(join(root, "company/agents/reviewer.md"), "Review code.\n");
  const { code } = await provision(root, home);
  expect(code).toBe(1);
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{ invalid");
  expect(existsSync(join(home, ".cursor/agents/company__reviewer.md"))).toBe(true);
  expect(existsSync(join(home, ".cursor/hooks.json"))).toBe(true);
  expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(true);
});

test("source failure provisions stale data and forces failure", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const { code, summaries } = await provision(root, home, { sourceFailed: true });
  expect(code).toBe(1);
  expect(existsSync(join(home, ".zshenv"))).toBe(true);
  expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(true);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toContain("Company source");
});

test("company provisioning needs no catalog and does not refresh the source", async () => {
  const root = scaffoldCompany();
  unlinkSync(join(root, "teams/t/catalog.yaml"));
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const calls: string[][] = [];
  const { code, summaries } = await provision(root, home, { exec: gitExec(calls) });
  expect(code).toBe(0);
  expect(existsSync(join(home, ".zshenv"))).toBe(true);
  expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(true);
  expect(calls.some((args) => args.includes("pull"))).toBe(false);
  expect(summaries[0]).toContain("warned 1 [Company catalog:");
});

test("a thrown registry parse error preserves MCP targets after earlier stages finish", async () => {
  const root = scaffoldCompany();
  writeFileSync(join(root, "company/registry.yaml"), "proxies: [");
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"personal":{"command":"local"}}}');
  const { code, summaries } = await provision(root, home);
  expect(code).toBe(1);
  expect(existsSync(join(home, ".zshenv"))).toBe(true);
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe('{"mcpServers":{"personal":{"command":"local"}}}');
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toContain("MCP configs");
});

for (const overwriteLocal of [false, true]) {
  test(`all categories share backups or suppress them (overwrite: ${overwriteLocal})`, async () => {
    const root = scaffoldCompany();
    const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
    mkdirSync(join(home, ".claude/agents"), { recursive: true });
    const originals = {
      ".claude/CLAUDE.md": "Personal instruction.\n",
      ".claude/agents/company__reviewer.md": "Old agent.\n",
      ".claude/settings.json": JSON.stringify({
        personal: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: "personal-hook" }] }] },
      }),
      ".claude.json": JSON.stringify({ personal: true, mcpServers: { personal: { command: "personal" } } }),
      ".zshenv": "export PERSONAL=yes\n# wagglebot:begin\nold\n# wagglebot:end\n",
    };
    for (const [path, content] of Object.entries(originals)) writeFileSync(join(home, path), content);
    mkdirSync(join(root, "company/agents"));
    writeFileSync(join(root, "company/agents/reviewer.md"), "New agent.\n");
    const calls: string[][] = [];
    const { code, lines } = await provision(root, home, { overwriteLocal, exec: gitExec(calls) });
    expect(code).toBe(0);
    expect(readFileSync(join(home, ".zshenv"), "utf8")).toContain("export PERSONAL=yes");
    const mcp = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(mcp.personal).toBe(true);
    expect(mcp.mcpServers.personal !== undefined).toBe(!overwriteLocal);
    expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8").includes("Personal instruction.")).toBe(
      !overwriteLocal,
    );
    const hooks = readFileSync(join(home, ".claude/settings.json"), "utf8");
    expect(hooks.includes("personal-hook")).toBe(!overwriteLocal);
    expect(JSON.parse(hooks).personal).toBe(true);
    expect(calls.some((args) => args.includes("--skill") && args.includes("*"))).toBe(overwriteLocal);
    expect(lines.join("\n")).not.toContain("secret-sentinel");
    const backupsDir = resolvePaths(home).backupsDir;
    if (overwriteLocal) expect(existsSync(backupsDir)).toBe(false);
    else {
      expect(readdirSync(backupsDir)).toHaveLength(1);
      const set = newestBackupSet(backupsDir);
      expect(set).toBeDefined();
      expect(restoreSet(set ?? "").failed).toEqual([]);
      for (const [path, content] of Object.entries(originals))
        expect(readFileSync(join(home, path), "utf8")).toBe(content);
    }
  });
}

const scaffoldCompany = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  mkdirSync(join(root, "company/instructions"), { recursive: true });
  // sync-shell reads the shipped script from node_modules, the way a real `yarn install`
  // leaves it. Fake that install here so runUpdate's sync-shell step does not fail.
  mkdirSync(join(root, "node_modules/wagglebot/templates/shell"), { recursive: true });
  writeFileSync(join(root, "node_modules/wagglebot/templates/shell/wagglebot.sh"), "# script\n");
  writeFileSync(
    join(root, "company/registry.yaml"),
    "proxies:\n  - { namespace: ex, mode: remote_http, endpoint: https://ex/mcp }\n",
  );
  mkdirSync(join(root, "teams/t"), { recursive: true });
  writeFileSync(
    join(root, "teams/t/catalog.yaml"),
    "kind: Group\nmetadata: { name: t }\nspec: { members: [alice] }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [t] }\n",
  );
  return root;
};

// runUpdate hands this to sync-shell, which creates the startup file of the login shell
// only. Pin $SHELL, so the assertions below hold on a bash machine as well as a zsh one.
const zshEnv = { ...process.env, SHELL: "/bin/zsh" };

const gitExec =
  (calls: string[][]): Exec =>
  async (cmd, args, _opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args.includes("wagglebot.username")) return { code: 0, stdout: "alice\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

test("pulls, provisions, and prints a summary", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const calls: string[][] = [];
  const lines: string[] = [];
  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec(calls),
    ask: async () => "alice",
    reporter: createReporter((l) => lines.push(l), false),
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(0);
  expect(calls[0]).toEqual(["git", "pull", "--ff-only"]);
  expect(lines.join("\n")).toContain("failed 0");
  expect(existsSync(join(home, ".zshenv"))).toBe(true);

  // The installers run in the documented order.
  const sections = ["Skills", "Custom agents", "Base template sync", "Shell environment", "MCP configs"].map((s) =>
    lines.indexOf(`== ${s} ==`),
  );
  for (const index of sections) expect(index).toBeGreaterThanOrEqual(0);
  for (let i = 1; i < sections.length; i += 1) {
    const prev = sections[i - 1] ?? -1;
    const current = sections[i] ?? -1;
    expect(current).toBeGreaterThan(prev);
  }
});

// The pull moves the wagglebot pin. That move is what makes runUpdate reach the self-update
// branch: yarn install, then a re-exec of the freshly installed CLI.
const pinMovingExec =
  (root: string, calls: string[][]): Exec =>
  async (cmd, args, _opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "pull") {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.5.0" } }));
    }
    if (cmd === "git" && args.includes("wagglebot.username")) return { code: 0, stdout: "alice\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

test("a moved pin triggers yarn install and a re-exec, once", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const calls: string[][] = [];
  const quiet = createReporter(() => {}, false);
  const code = await runUpdate({
    cwd: root,
    home,
    exec: pinMovingExec(root, calls),
    ask: async () => "alice",
    reporter: quiet,
    write: () => {},
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(0);
  expect(calls).toContainEqual(["yarn", "install"]);
  expect(calls).toContainEqual(["yarn", "wagglebot", "update", "--skip-self-update"]);
});

test("one runUpdate makes a single backup set that restores both CLAUDE.md and .claude.json", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# my personal rules\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { personal: { command: "my-mcp" } } }));

  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec([]),
    ask: async () => "alice",
    reporter: createReporter(() => {}, false),
    write: () => {},
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(0);

  const paths = resolvePaths(home);
  expect(readdirSync(paths.backupsDir)).toHaveLength(1);

  // Overwrite both files, then restore the newest (only) backup set and confirm both come back.
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# clobbered\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  const set = newestBackupSet(paths.backupsDir);
  expect(set).toBeDefined();
  const restored = restoreSet(set ?? "").restored;
  expect(restored).toContain(join(home, ".claude/CLAUDE.md"));
  expect(restored).toContain(join(home, ".claude.json"));
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# my personal rules\n");
  const doc: { mcpServers: { personal?: unknown } } = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc.mcpServers.personal).toBeDefined();
});

test("a failing yarn install prints the summary before it exits 1", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const pinMoving = pinMovingExec(root, []);
  const lines: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "yarn" && args[0] === "install") return { code: 1, stdout: "", stderr: "error Couldn't find package" };
    return pinMoving(cmd, args, opts);
  };
  const r = createReporter((l) => lines.push(l), false);
  const code = await runUpdate({
    cwd: root,
    home,
    exec,
    ask: async () => "alice",
    reporter: r,
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(1);
  expect(lines.some((l) => l.includes("failed 1"))).toBe(true);
});

test("a missing yarn keeps the current CLI, warns, and still runs the installers", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const pinMoving = pinMovingExec(root, []);
  const lines: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    // realExec marks a command that does not exist with notFound.
    if (cmd === "yarn") return { code: 127, stdout: "", stderr: "", notFound: true };
    return pinMoving(cmd, args, opts);
  };
  const r = createReporter((l) => lines.push(l), false);
  const code = await runUpdate({
    cwd: root,
    home,
    exec,
    ask: async () => "alice",
    reporter: r,
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(lines.some((l) => l.includes("yarn is not installed"))).toBe(true);
  // Both remedies end with the same sentence. The run prints one of them, never both.
  expect(lines.filter((l) => l.includes("run wagglebot update again")).length).toBe(1);
  expect(lines.some((l) => l.includes("== Base template sync =="))).toBe(true);
  expect(r.counts().failed).toBe(0);
  expect(code).toBe(0);
});

test("a yarn that exits 127 is a failure, not a missing yarn", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const pinMoving = pinMovingExec(root, []);
  const lines: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "yarn") return { code: 127, stdout: "", stderr: "error: a lifecycle script is missing" };
    return pinMoving(cmd, args, opts);
  };
  const r = createReporter((l) => lines.push(l), false);
  const code = await runUpdate({
    cwd: root,
    home,
    exec,
    ask: async () => "alice",
    reporter: r,
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(lines.some((l) => l.includes("yarn is not installed"))).toBe(false);
});

test("a pin that did not move this run still reports the stale CLI", async () => {
  const root = scaffoldCompany();
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.5.0" } }));
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec([]),
    ask: async () => "alice",
    reporter: r,
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain(
    'the company pins wagglebot 1.5.0, but this run uses 1.4.2 — run "yarn install" in the company repository, then run wagglebot update again',
  );
  // The run continues: every installer still reports its section.
  expect(lines).toContain("== Base template sync ==");
  expect(r.counts().failed).toBe(0);
});

test("a pin that is a range or a path reports no stale CLI", async () => {
  for (const pin of ["1.2.3 - 2.0.0", "^1.5.0", "file:../packages/cli"]) {
    const root = scaffoldCompany();
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies.wagglebot = pin;
    writeFileSync(pkgPath, JSON.stringify(pkg));
    const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const lines: string[] = [];
    await runUpdate({
      cwd: root,
      home,
      exec: gitExec([]),
      ask: async () => "alice",
      reporter: createReporter((l) => lines.push(l), false),
      write: (l) => lines.push(l),
      skillsBin: "/bin/skills",
      cliVersion: "1.4.2",
      env: zshEnv,
    });
    expect(lines.some((l) => l.includes("the company pins wagglebot"))).toBe(false);
  }
});

test("a pin that equals the running CLI reports nothing", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const lines: string[] = [];
  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec([]),
    ask: async () => "alice",
    reporter: createReporter((l) => lines.push(l), false),
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  expect(code).toBe(0);
  expect(lines.join("\n")).not.toContain("the company pins wagglebot");
});

// The organization key travels from package.json through runUpdate into the list parser.
const updateWithSkillsList = async (organization?: string[]): Promise<string[]> => {
  const root = scaffoldCompany();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { wagglebot: "1.4.2" },
      ...(organization === undefined ? {} : { wagglebot: { organization } }),
    }),
  );
  writeFileSync(join(root, "company/skills.list"), "acme/internal-skills\n");
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const lines: string[] = [];
  await runUpdate({
    cwd: root,
    home,
    exec: gitExec([]),
    ask: async () => "alice",
    reporter: createReporter((l) => lines.push(l), false),
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
    cliVersion: "1.4.2",
    env: zshEnv,
  });
  return lines;
};

test("a declared wagglebot.organization silences the pin warning of an entry it owns", async () => {
  const undeclared = await updateWithSkillsList();
  expect(undeclared.join("\n")).toContain("acme/internal-skills: no pin");
  const declared = await updateWithSkillsList(["github.com/acme"]);
  expect(declared.join("\n")).not.toContain("no pin");
});
