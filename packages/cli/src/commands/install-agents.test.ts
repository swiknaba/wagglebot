import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackupSet } from "../backup";
import type { Exec } from "../exec";
import { HARNESSES } from "../harness";
import { createReporter } from "../report";
import { loadState, saveState } from "../state";
import { resolveSource, runInstallAgents } from "./install-agents";

const quiet = () => createReporter(() => {}, false);

const AGENT_DIRS = [
  ".claude/agents",
  ".junie/agents",
  ".gemini/agents",
  ".copilot/agents",
  ".cursor/agents",
  ".config/devin/agents",
  ".kiro/agents",
];

test("unsupported-only selection skips agent sources without failure or state changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const stateFile = join(home, ".wagglebot/managed.json");
  const state = { jsonKeys: {}, agentFiles: [join(home, ".claude/agents/old.md")], skills: { "a/b": ["codex"] } };
  saveState(stateFile, state);
  let calls = 0;
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES.filter((h) => h.name === "codex" || h.name === "cline"),
      listTexts: [{ path: "agents.list", text: "bad/repo@v1" }],
      agentDirs: [],
      reporter: quiet(),
      exec: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "Cannot clone" };
      },
    }),
  ).toBe(0);
  expect(calls).toBe(0);
  expect(loadState(stateFile)).toEqual(state);
});

test("an unsafe local prefix cannot write outside a dedicated directory and valid sources continue", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const source = join(home, "source");
  mkdirSync(source);
  writeFileSync(join(source, "review.md"), "# Reviewer\n");
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [
        { prefix: "../", dir: source },
        { prefix: "company__", dir: source },
      ],
      exec: fakeGit,
      reporter: quiet(),
    }),
  ).toBe(1);
  expect(existsSync(join(home, ".claude/review.md"))).toBe(false);
  expect(readFileSync(join(home, ".claude/agents/company__review.md"), "utf8")).toBe("# Reviewer\n");
});

test("a destination symlink preserves its target and independent agent files still install", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const source = join(home, "source");
  mkdirSync(source);
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(join(source, "review.md"), "# Reviewer\n");
  writeFileSync(join(source, "other.md"), "# Other\n");
  const personal = join(home, "personal.md");
  writeFileSync(personal, "personal");
  symlinkSync(personal, join(home, ".claude/agents/company__review.md"));
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [{ prefix: "company__", dir: source }],
      exec: fakeGit,
      reporter: quiet(),
    }),
  ).toBe(1);
  expect(readFileSync(personal, "utf8")).toBe("personal");
  expect(readFileSync(join(home, ".claude/agents/company__other.md"), "utf8")).toBe("# Other\n");
  expect(loadState(join(home, ".wagglebot/managed.json")).agentFiles).not.toContain(
    join(home, ".claude/agents/company__review.md"),
  );
});

test.each(["file", "dangling"])("overwrite rejects a %s directory before any removal", async (kind) => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(join(home, ".claude/agents/keep.md"), "keep");
  if (kind === "file") writeFileSync(join(home, ".junie"), "file");
  else symlinkSync(join(home, "missing"), join(home, ".junie"));
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [],
      exec: fakeGit,
      reporter: quiet(),
      overwriteLocal: true,
    }),
  ).toBe(1);
  expect(readFileSync(join(home, ".claude/agents/keep.md"), "utf8")).toBe("keep");
});

test("all custom-agent directories install local agents and report Codex and Cline unsupported", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const source = join(home, "source");
  mkdirSync(source);
  writeFileSync(join(source, "review.md"), "# Local reviewer\n");
  const lines: string[] = [];
  expect(HARNESSES.flatMap((h) => h.subagentDirs)).toEqual(AGENT_DIRS);
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [{ prefix: "company__", dir: source }],
      exec: fakeGit,
      reporter: createReporter((line) => lines.push(line), false),
    }),
  ).toBe(0);
  for (const dir of AGENT_DIRS)
    expect(readFileSync(join(home, dir, "company__review.md"), "utf8")).toBe("# Local reviewer\n");
  expect(lines.some((line) => /unsupported/i.test(line) && line.includes("codex") && line.includes("cline"))).toBe(
    true,
  );
});

test("default cleanup removes only state-owned stale files in selected agent directories", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const owned = join(home, ".claude/agents/company__old.md");
  const personal = join(home, ".claude/agents/company__personal.md");
  const other = join(home, ".junie/agents/company__keep.md");
  for (const dir of [".claude/agents", ".junie/agents"]) mkdirSync(join(home, dir), { recursive: true });
  for (const file of [owned, personal, other]) writeFileSync(file, "keep");
  saveState(join(home, ".wagglebot/managed.json"), { jsonKeys: {}, agentFiles: [owned, other], skills: {} });
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES.filter((h) => h.name === "claude-code"),
      listTexts: [],
      agentDirs: [],
      exec: fakeGit,
      reporter: quiet(),
    }),
  ).toBe(0);
  expect(existsSync(owned)).toBe(false);
  expect(readFileSync(personal, "utf8")).toBe("keep");
  expect(readFileSync(other, "utf8")).toBe("keep");
  expect(loadState(join(home, ".wagglebot/managed.json")).agentFiles).toEqual([other]);
});

test("overwrite replaces exact dedicated directories, resets state, and creates no backup", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const source = join(home, "source");
  mkdirSync(source);
  writeFileSync(join(source, "review.md"), "# Effective\n");
  const oldFiles: string[] = [];
  for (const dir of AGENT_DIRS) {
    mkdirSync(join(home, dir, "nested"), { recursive: true });
    writeFileSync(join(home, dir, "personal.md"), "personal");
    writeFileSync(join(home, dir, "nested/old.md"), "old");
    oldFiles.push(join(home, dir, "nested/old.md"));
  }
  writeFileSync(join(home, ".claude/settings.json"), "personal settings");
  const stateFile = join(home, ".wagglebot/managed.json");
  saveState(stateFile, { jsonKeys: { config: ["mcp"] }, agentFiles: oldFiles, skills: { "a/b": ["codex"] } });
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [{ prefix: "company__", dir: source }],
      exec: fakeGit,
      reporter: quiet(),
      overwriteLocal: true,
      backups: {
        dir: "unused",
        backup: () => {
          throw new Error("Overwrite must not create a backup.");
        },
      },
    }),
  ).toBe(0);
  for (const dir of AGENT_DIRS) expect(readdirSync(join(home, dir))).toEqual(["company__review.md"]);
  expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe("personal settings");
  expect(existsSync(join(home, ".wagglebot/backups"))).toBe(false);
  expect(loadState(stateFile)).toEqual({
    jsonKeys: { config: ["mcp"] },
    agentFiles: AGENT_DIRS.map((dir) => join(home, dir, "company__review.md")),
    skills: { "a/b": ["codex"] },
  });
});

test("empty overwrite recreates every dedicated directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [],
      exec: fakeGit,
      reporter: quiet(),
      overwriteLocal: true,
    }),
  ).toBe(0);
  for (const dir of AGENT_DIRS) expect(readdirSync(join(home, dir))).toEqual([]);
});

test.each([
  "",
  ".",
  "..",
  "../outside/agents",
  "/tmp/agents",
  ".claude/../../outside/agents",
  ".claude",
  ".claude/../agents",
])("overwrite rejects %j before any directory removal", async (invalid) => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const keep = join(home, ".claude/agents/personal.md");
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(keep, "keep");
  const harness = HARNESSES[0];
  if (harness === undefined) throw new Error("Missing harness.");
  expect(
    await runInstallAgents({
      home,
      harnesses: [{ ...harness, subagentDirs: [".claude/agents", invalid] }],
      listTexts: [],
      agentDirs: [],
      exec: fakeGit,
      reporter: quiet(),
      overwriteLocal: true,
    }),
  ).toBe(1);
  expect(readFileSync(keep, "utf8")).toBe("keep");
});

test.each(["parent", "target"])("overwrite rejects a symbolic link at the %s before any removal", async (location) => {
  const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
  const outside = mkdtempSync(join(tmpdir(), "wgl-outside-"));
  mkdirSync(join(outside, "agents"));
  writeFileSync(join(outside, "agents/keep.md"), "keep");
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(join(home, ".claude/agents/keep.md"), "keep");
  if (location === "parent") symlinkSync(outside, join(home, ".junie"));
  else {
    mkdirSync(join(home, ".junie"));
    symlinkSync(join(outside, "agents"), join(home, ".junie/agents"));
  }
  expect(
    await runInstallAgents({
      home,
      harnesses: HARNESSES,
      listTexts: [],
      agentDirs: [],
      exec: fakeGit,
      reporter: quiet(),
      overwriteLocal: true,
    }),
  ).toBe(1);
  expect(readFileSync(join(home, ".claude/agents/keep.md"), "utf8")).toBe("keep");
  expect(readFileSync(join(outside, "agents/keep.md"), "utf8")).toBe("keep");
});

test.each([false, true])(
  "a clone failure permits local installation and returns failure (overwrite: %s)",
  async (overwriteLocal) => {
    const home = mkdtempSync(join(tmpdir(), "wgl-agents-"));
    const source = join(home, "source");
    mkdirSync(source);
    writeFileSync(join(source, "review.md"), "# Local reviewer\n");
    expect(
      await runInstallAgents({
        home,
        harnesses: HARNESSES,
        listTexts: [{ path: "agents.list", text: "bad/repo@v1" }],
        agentDirs: [{ prefix: "company__", dir: source }],
        exec: async () => ({ code: 1, stdout: "", stderr: "Clone failed" }),
        reporter: quiet(),
        overwriteLocal,
      }),
    ).toBe(1);
    for (const dir of AGENT_DIRS)
      expect(readFileSync(join(home, dir, "company__review.md"), "utf8")).toBe("# Local reviewer\n");
    expect(loadState(join(home, ".wagglebot/managed.json")).agentFiles).toHaveLength(7);
  },
);

// "clone" creates the dir with one agent file; every other git call is a no-op success.
const fakeGit: Exec = async (cmd, args) => {
  if (cmd === "git" && args[0] === "clone") {
    const dir = args.at(-1) ?? "";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reviewer.md"), "# Reviewer agent\n");
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

test("installs list agents into the Claude Code subagent dir with prefixed names", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const code = await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "agents.base.list", text: "acme/agents@abc1234\n" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(code).toBe(0);
  const installed = join(home, ".claude/agents/acme__agents__reviewer.md");
  expect(readFileSync(installed, "utf8")).toBe("# Reviewer agent\n");
});

test("second run reports ok; a removed entry uninstalls its files", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const lists = [{ path: "agents.base.list", text: "acme/agents@abc1234\n" }];
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: lists,
    agentDirs: [],
    exec: fakeGit,
    reporter: quiet(),
  });
  const r = createReporter(() => {}, false);
  await runInstallAgents({ home, harnesses: HARNESSES, listTexts: lists, agentDirs: [], exec: fakeGit, reporter: r });
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(r.counts().installed).toBe(0);
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "agents.base.list", text: "" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(existsSync(join(home, ".claude/agents/acme__agents__reviewer.md"))).toBe(false);
});

test("a failing pull on an unpinned, already-cached entry reports failed and keeps the file installed", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const unpinned = [{ path: "agents.base.list", text: "acme/agents\n" }];
  // First run: clone succeeds, materializing reviewer.md and installing it.
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: unpinned,
    agentDirs: [],
    exec: fakeGit,
    reporter: quiet(),
  });
  const installed = join(home, ".claude/agents/acme__agents__reviewer.md");
  expect(existsSync(installed)).toBe(true);

  // Second run: the cache dir already exists, so materialize() takes the "pull" branch,
  // which now fails. A transient git failure must not uninstall the previously installed file.
  const failingPull: Exec = async (cmd, args) => {
    if (cmd === "git" && args.includes("pull")) return { code: 1, stdout: "", stderr: "not fast-forward" };
    return fakeGit(cmd, args);
  };
  const r = createReporter(() => {}, false);
  const code = await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: unpinned,
    agentDirs: [],
    exec: failingPull,
    reporter: r,
  });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(r.counts().installed).toBe(0);
  expect(existsSync(installed)).toBe(true);
  const state: { agentFiles: string[] } = JSON.parse(readFileSync(join(home, ".wagglebot/managed.json"), "utf8"));
  expect(state.agentFiles).toContain(installed);
});

test("installs company agents/ files with the company__ prefix, skipping README.md", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const companyAgentsDir = mkdtempSync(join(tmpdir(), "wgl-co-agents-"));
  writeFileSync(join(companyAgentsDir, "reviewer.md"), "# Company reviewer agent\n");
  writeFileSync(join(companyAgentsDir, "README.md"), "# Shared Subagents\n");
  const code = await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [],
    agentDirs: [{ prefix: "company__", dir: companyAgentsDir }],
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(code).toBe(0);
  expect(readFileSync(join(home, ".claude/agents/company__reviewer.md"), "utf8")).toBe("# Company reviewer agent\n");
  expect(existsSync(join(home, ".claude/agents/company__README.md"))).toBe(false);
});

test("installs a team agents/ directory with its own prefix alongside company agents", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const companyAgentsDir = mkdtempSync(join(tmpdir(), "wgl-co-agents-"));
  const teamAgentsDir = mkdtempSync(join(tmpdir(), "wgl-team-agents-"));
  writeFileSync(join(companyAgentsDir, "reviewer.md"), "# Company reviewer agent\n");
  writeFileSync(join(teamAgentsDir, "reviewer.md"), "# Team reviewer agent\n");
  const code = await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [],
    agentDirs: [
      { prefix: "company__", dir: companyAgentsDir },
      { prefix: "platform__", dir: teamAgentsDir },
    ],
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(code).toBe(0);
  expect(readFileSync(join(home, ".claude/agents/company__reviewer.md"), "utf8")).toBe("# Company reviewer agent\n");
  expect(readFileSync(join(home, ".claude/agents/platform__reviewer.md"), "utf8")).toBe("# Team reviewer agent\n");
});

test("removing a file from the company agents/ directory uninstalls it on the next run", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const companyAgentsDir = mkdtempSync(join(tmpdir(), "wgl-co-agents-"));
  writeFileSync(join(companyAgentsDir, "reviewer.md"), "# Company reviewer agent\n");
  const agentDirs = [{ prefix: "company__", dir: companyAgentsDir }];
  await runInstallAgents({ home, harnesses: HARNESSES, listTexts: [], agentDirs, exec: fakeGit, reporter: quiet() });
  const installed = join(home, ".claude/agents/company__reviewer.md");
  expect(existsSync(installed)).toBe(true);

  rmSync(join(companyAgentsDir, "reviewer.md"));
  await runInstallAgents({ home, harnesses: HARNESSES, listTexts: [], agentDirs, exec: fakeGit, reporter: quiet() });
  expect(existsSync(installed)).toBe(false);
});

test("a harness with no subagent directory produces no files and reports one skipped line", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const codex = HARNESSES.find((h) => h.name === "codex");
  if (codex === undefined) throw new Error("codex missing");
  const r = createReporter(() => {}, false);
  const code = await runInstallAgents({
    home,
    harnesses: [codex],
    listTexts: [{ path: "agents.base.list", text: "acme/agents@abc1234\n" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: r,
  });
  expect(code).toBe(0);
  expect(r.counts().installed).toBe(0);
  expect(r.counts().skipped).toBe(1);
});

test("resolveSource maps GitHub shorthand and full URLs to a clone URL, ref, and prefix id", () => {
  expect(resolveSource({ repo: "acme/agents", ref: "v1", raw: "acme/agents@v1" })).toEqual({
    cloneUrl: "https://github.com/acme/agents.git",
    ref: "v1",
    id: "acme__agents",
  });
  const https = "https://git.my-company.local/platform/agents.git";
  expect(resolveSource({ repo: https, ref: "v1.2.0", raw: `${https} v1.2.0`, isUrl: true })).toEqual({
    cloneUrl: "https://git.my-company.local/platform/agents.git",
    ref: "v1.2.0",
    id: "platform__agents",
  });
  const ssh = "git@git.my-company.local:platform/agents.git";
  expect(resolveSource({ repo: ssh, raw: ssh, isUrl: true })).toEqual({
    cloneUrl: ssh,
    ref: undefined,
    id: "platform__agents",
  });
});

test("installs from a private git host by full URL and checks out the ref", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const calls: string[][] = [];
  const recording: Exec = async (cmd, args) => {
    calls.push(args);
    return fakeGit(cmd, args);
  };
  const code = await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "agents.base.list", text: "https://git.my-company.local/platform/agents.git v1.2.0\n" }],
    agentDirs: [],
    exec: recording,
    reporter: quiet(),
  });
  expect(code).toBe(0);
  expect(calls[0]?.slice(0, 2)).toEqual(["clone", "https://git.my-company.local/platform/agents.git"]);
  expect(calls.some((args) => args.includes("checkout") && args.includes("v1.2.0"))).toBe(true);
  expect(existsSync(join(home, ".claude/agents/platform__agents__reviewer.md"))).toBe(true);
});

test("an unpinned third-party agents entry is a warning line", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const lines: string[] = [];
  const claude = HARNESSES.find((h) => h.name === "claude-code");
  if (claude === undefined) throw new Error("fixture");
  const r = createReporter((l) => lines.push(l), false);
  // Claude Code alone, so the only skip a harness could add stays out of the count.
  const code = await runInstallAgents({
    home,
    harnesses: [claude],
    listTexts: [{ path: "agents.base.list", text: "acme/agents\n" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: r,
  });
  expect(lines.some((l) => l.includes("warning") && l.includes("acme/agents"))).toBe(true);
  // A warning is not a counted item, and it never fails the run.
  expect(code).toBe(0);
  expect(r.counts().skipped).toBe(0);
});

test("a README.md in a cloned repository is not installed as a subagent", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const git: Exec = async (cmd, args) => {
    if (cmd === "git" && args[0] === "clone") {
      const dir = args.at(-1) ?? "";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "README.md"), "# About\n");
      writeFileSync(join(dir, "reviewer.md"), "# Reviewer agent\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "l", text: "acme/agents@v1\n" }],
    agentDirs: [],
    exec: git,
    reporter: quiet(),
  });
  expect(existsSync(join(home, ".claude/agents/acme__agents__README.md"))).toBe(false);
  expect(existsSync(join(home, ".claude/agents/acme__agents__reviewer.md"))).toBe(true);
});

test("an existing subagent file is backed up before it is overwritten", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const dest = join(home, ".claude/agents/acme__agents__reviewer.md");
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(dest, "# Old\n");
  const backups = startBackupSet(join(home, ".wagglebot/backups"));
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "l", text: "acme/agents@v1\n" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: quiet(),
    backups,
  });
  expect(readFileSync(dest, "utf8")).toBe("# Reviewer agent\n");
  expect(readFileSync(join(backups.dir, dest.replaceAll("/", "%2F")), "utf8")).toBe("# Old\n");
});

test("a symbolic link in a cloned repository is not installed as a subagent", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const secret = join(home, "secret.txt");
  writeFileSync(secret, "top secret\n");
  const git: Exec = async (cmd, args) => {
    if (cmd === "git" && args[0] === "clone") {
      const dir = args.at(-1) ?? "";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "reviewer.md"), "# Reviewer agent\n");
      symlinkSync(secret, join(dir, "leak.md"));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "l", text: "acme/agents@v1\n" }],
    agentDirs: [],
    exec: git,
    reporter: quiet(),
  });
  expect(existsSync(join(home, ".claude/agents/acme__agents__leak.md"))).toBe(false);
  expect(existsSync(join(home, ".claude/agents/acme__agents__reviewer.md"))).toBe(true);
});
