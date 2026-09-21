import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { HARNESSES } from "../harness";
import { parseList } from "../lists";
import { createReporter } from "../report";
import { loadState, saveState } from "../state";
import { nodeSatisfies, runInstallSkills, toSkillsSource } from "./install-skills";

const quiet = () => createReporter(() => {}, false);
const managed = () => join(mkdtempSync(join(tmpdir(), "wgl-sk-")), "managed.json");
const NODE = "v24.0.0";
const ADAPTERS = [
  "claude-code",
  "codex",
  "junie",
  "gemini-cli",
  "github-copilot",
  "cline",
  "cursor",
  "devin",
  "windsurf",
  "kiro-cli",
];

test.each(["*", "--all", "invalid-adapter"])("overwrite rejects adapter %j before any removal", async (adapter) => {
  const calls: string[][] = [];
  const file = managed();
  saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b": ["claude-code"] } });
  expect(
    await runInstallSkills({
      lists: [],
      exec: fakeExec(calls),
      reporter: quiet(),
      skillsBin: "/bin/skills",
      skillsAgents: ["claude-code", adapter],
      managedFile: file,
      skillLockFile: NO_LOCK,
      nodeVersion: NODE,
      overwriteLocal: true,
    }),
  ).toBe(1);
  expect(calls).toEqual([]);
  expect(loadState(file).skills).toEqual({ "a/b": ["claude-code"] });
});

test("failed additions retain prior ownership and successful pin changes preserve unselected adapters", async () => {
  const file = managed();
  saveState(file, {
    jsonKeys: {},
    agentFiles: [],
    skills: { "fail/fail@v1": ["claude-code"], "a/b@v1": ["claude-code", "codex"] },
  });
  expect(
    await runInstallSkills({
      lists: [{ path: "skills.list", text: "fail/fail@v1\na/b@v2" }],
      exec: fakeExec([]),
      reporter: quiet(),
      skillsBin: "/bin/skills",
      skillsAgents: ["claude-code"],
      managedFile: file,
      skillLockFile: NO_LOCK,
      nodeVersion: NODE,
    }),
  ).toBe(1);
  expect(loadState(file).skills).toEqual({
    "fail/fail@v1": ["claude-code"],
    "a/b@v1": ["codex"],
    "a/b@v2": ["claude-code"],
  });
});

test("installs into all ten declared adapters after one overwrite removal per adapter", async () => {
  const calls: string[][] = [];
  const file = managed();
  saveState(file, { jsonKeys: { config: ["mcp"] }, agentFiles: ["agent.md"], skills: { "old/repo": ADAPTERS } });
  expect(HARNESSES.flatMap((h) => h.skillsAgents)).toEqual(ADAPTERS);
  const code = await runInstallSkills({
    lists: [{ path: "skills.list", text: "new/repo@v1" }],
    exec: fakeExec(calls),
    reporter: quiet(),
    skillsBin: "/bin/skills",
    skillsAgents: HARNESSES.flatMap((h) => h.skillsAgents),
    managedFile: file,
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
    overwriteLocal: true,
  });
  expect(code).toBe(0);
  expect(calls.slice(0, 10)).toEqual(
    [...ADAPTERS]
      .sort()
      .map((agent) => [
        process.execPath,
        "/bin/skills",
        "remove",
        "--skill",
        "*",
        "--global",
        "--yes",
        "--agent",
        agent,
      ]),
  );
  expect(calls[10]).toEqual([
    process.execPath,
    "/bin/skills",
    "add",
    "new/repo#v1",
    "-g",
    "-y",
    ...[...ADAPTERS].sort().flatMap((agent) => ["-a", agent]),
  ]);
  expect(loadState(file)).toEqual({
    jsonKeys: { config: ["mcp"] },
    agentFiles: ["agent.md"],
    skills: { "new/repo@v1": [...ADAPTERS].sort() },
  });
});

test("empty overwrite clears only selected adapters and resets their state", async () => {
  const file = managed();
  const calls: string[][] = [];
  saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b": ["claude-code", "codex"] } });
  expect(
    await runInstallSkills({
      lists: [],
      exec: fakeExec(calls),
      reporter: quiet(),
      skillsBin: "/bin/skills",
      skillsAgents: ["claude-code", "claude-code"],
      managedFile: file,
      skillLockFile: NO_LOCK,
      nodeVersion: NODE,
      overwriteLocal: true,
    }),
  ).toBe(0);
  expect(calls).toEqual([
    [process.execPath, "/bin/skills", "remove", "--skill", "*", "--global", "--yes", "--agent", "claude-code"],
  ]);
  expect(loadState(file).skills).toEqual({ "a/b": ["codex"] });
});

test("an empty effective list removes state-owned skills and preserves personal skills", async () => {
  const file = managed();
  const lock = lockFile({
    managed: { source: "a/b", updatedAt: "2020-01-01" },
    personal: { source: "my/skills", updatedAt: "2020-01-01" },
  });
  const calls: string[][] = [];
  saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b": ["claude-code"] } });
  expect(
    await runInstallSkills({
      lists: [],
      exec: lockWritingExec(calls, lock, {}),
      reporter: quiet(),
      skillsBin: "/bin/skills",
      skillsAgents: ["claude-code"],
      managedFile: file,
      skillLockFile: lock,
      nodeVersion: NODE,
    }),
  ).toBe(0);
  expect(calls).toEqual([[process.execPath, "/bin/skills", "remove", "managed", "-g", "-y", "-a", "claude-code"]]);
  expect(Object.keys(JSON.parse(readFileSync(lock, "utf8")).skills)).toEqual(["personal"]);
  expect(loadState(file).skills).toEqual({});
});

test("failed removal retains state for retry and does not stop independent installs", async () => {
  for (const overwriteLocal of [false, true]) {
    const file = managed();
    const calls: string[][] = [];
    const lock = lockFile({ old: { source: "a/b", updatedAt: "2020-01-01" } });
    saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b": ["claude-code"] } });
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: args[1] === "remove" ? 1 : 0, stdout: "", stderr: "" };
    };
    expect(
      await runInstallSkills({
        lists: [{ path: "skills.list", text: "new/repo@v1" }],
        exec,
        reporter: quiet(),
        skillsBin: "/bin/skills",
        skillsAgents: ["claude-code"],
        managedFile: file,
        skillLockFile: lock,
        nodeVersion: NODE,
        overwriteLocal,
      }),
    ).toBe(1);
    expect(loadState(file).skills).toEqual({ "a/b": ["claude-code"], "new/repo@v1": ["claude-code"] });
    expect(calls.some((call) => call.includes("add"))).toBe(true);
  }
});

const REMOVAL_FAILURES = [
  { stream: "stdout", output: "Could not remove skill from Claude Code: EACCES: permission denied" },
  { stream: "stderr", output: "Could not remove skill from Claude Code: EACCES: permission denied" },
  { stream: "stdout", output: "\u001b[31mFailed to remove 1 skill(s)\u001b[39m" },
  { stream: "stderr", output: "\u001b[31mFailed to remove 1 skill(s)\u001b[39m" },
  { stream: "stdout", output: "Could not scan directory /home/.claude/skills: EACCES: permission denied" },
  { stream: "stderr", output: "Could not scan directory /home/.claude/skills: EACCES: permission denied" },
];

test.each(REMOVAL_FAILURES)(
  "zero-exit removal preserves ownership when $stream reports $output",
  async ({ stream, output }) => {
    for (const overwriteLocal of [false, true]) {
      const file = managed();
      const lock = lockFile({ old: { source: "a/b", updatedAt: "2020-01-01" } });
      saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b": ["claude-code"] } });
      const reporter = quiet();
      const exec: Exec = async (_cmd, args) => ({
        code: 0,
        stdout: "Successfully removed 1 skill(s)\nDone!",
        stderr: "",
        ...(args[1] === "remove" ? { [stream]: `Successfully removed 1 skill(s)\n${output}\nDone!` } : {}),
      });
      expect(
        await runInstallSkills({
          lists: [{ path: "skills.list", text: "new/repo@v1" }],
          exec,
          reporter,
          skillsBin: "/bin/skills",
          skillsAgents: ["claude-code"],
          managedFile: file,
          skillLockFile: lock,
          nodeVersion: NODE,
          overwriteLocal,
        }),
      ).toBe(1);
      expect(loadState(file).skills).toEqual({ "a/b": ["claude-code"], "new/repo@v1": ["claude-code"] });
      expect(reporter.counts()).toMatchObject({ failed: 1, installed: 1, updated: 0 });
    }
  },
);

test("zero-exit partial overwrite clears only successful adapters and continues installation", async () => {
  const file = managed();
  const calls: string[][] = [];
  saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b": ["claude-code", "codex"] } });
  const reporter = quiet();
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "remove")
      return {
        code: 0,
        stdout:
          args.at(-1) === "claude-code"
            ? "Could not remove skill from Claude Code: EACCES: permission denied\nSuccessfully removed 1 skill(s)\nDone!"
            : "Successfully removed 1 skill(s)\nDone!",
        stderr: "",
      };
    expect(loadState(file).skills).toEqual({ "a/b": ["claude-code"] });
    return { code: 0, stdout: "Installed 1 skill", stderr: "" };
  };
  expect(
    await runInstallSkills({
      lists: [{ path: "skills.list", text: "new/repo@v1" }],
      exec,
      reporter,
      skillsBin: "/bin/skills",
      skillsAgents: ["claude-code", "codex"],
      managedFile: file,
      skillLockFile: NO_LOCK,
      nodeVersion: NODE,
      overwriteLocal: true,
    }),
  ).toBe(1);
  expect(calls).toEqual([
    [process.execPath, "/bin/skills", "remove", "--skill", "*", "--global", "--yes", "--agent", "claude-code"],
    [process.execPath, "/bin/skills", "remove", "--skill", "*", "--global", "--yes", "--agent", "codex"],
    [process.execPath, "/bin/skills", "add", "new/repo#v1", "-g", "-y", "-a", "claude-code", "-a", "codex"],
  ]);
  expect(loadState(file).skills).toEqual({ "a/b": ["claude-code"], "new/repo@v1": ["claude-code", "codex"] });
  expect(reporter.counts()).toMatchObject({ failed: 1, updated: 1, installed: 1 });
});
// No lock file: skillsOfSource then reports nothing for every source, so no test that does not
// write one can install a new skill or remove a stale one.
const NO_LOCK = join(mkdtempSync(join(tmpdir(), "wgl-lk-")), "absent.json");

const lockFile = (skills: Record<string, { source: string; updatedAt: string }>): string => {
  const file = join(mkdtempSync(join(tmpdir(), "wgl-lk-")), ".skill-lock.json");
  writeFileSync(file, JSON.stringify({ version: 3, skills }));
  return file;
};
// The skills CLI stamps updatedAt on every skill it writes. This exec does the same, so a test
// can name the skills a source still provides and let the stale ones keep an old stamp.
const lockWritingExec = (calls: string[][], file: string, provides: Record<string, string[]>): Exec => {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "add") {
      const source = (args[2] ?? "").split("#")[0] ?? "";
      const raw: { version: number; skills: Record<string, unknown> } = JSON.parse(readFileSync(file, "utf8"));
      for (const name of provides[source] ?? [])
        raw.skills[name] = {
          source,
          sourceUrl: `https://github.com/${source}.git`,
          updatedAt: new Date(Date.now() + 5).toISOString(),
        };
      writeFileSync(file, JSON.stringify(raw));
    }
    if (args[1] === "remove") {
      const raw: { version: number; skills: Record<string, unknown> } = JSON.parse(readFileSync(file, "utf8"));
      delete raw.skills[args[2] ?? ""];
      writeFileSync(file, JSON.stringify(raw));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
};

const fakeExec =
  (calls: string[][]): Exec =>
  async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[2] === "fail/fail#v1") return { code: 1, stdout: "■ Installation failed", stderr: "" };
    return { code: 0, stdout: "Installed 3 skills", stderr: "" };
  };

// parseList never returns an empty entries array for a non-empty input line, but its
// type says otherwise. Assert that here instead of a non-null assertion at each call site.
const first = (text: string) => {
  const entry = parseList(text).entries[0];
  if (entry === undefined) throw new Error("no entry");
  return entry;
};

test("translates our @ref format into the skills CLI #ref format", () => {
  expect(toSkillsSource(first("obra/superpowers@v6.3.0"))).toBe("obra/superpowers#v6.3.0");
  expect(toSkillsSource(first("obra/superpowers"))).toBe("obra/superpowers");
  expect(toSkillsSource(first("https://git.x/a/b.git v1"))).toBe("https://git.x/a/b.git#v1");
});

test("node version floor", () => {
  expect(nodeSatisfies("v22.20.0", "22.20.0")).toBe(true);
  expect(nodeSatisfies("v24.1.0", "22.20.0")).toBe(true);
  expect(nodeSatisfies("v22.15.0", "22.20.0")).toBe(false);
  expect(nodeSatisfies("v20.12.2", "22.20.0")).toBe(false);
});

test("installs into every selected agent, records state, and is ok on the second run", async () => {
  const calls: string[][] = [];
  const file = managed();
  const deps = {
    lists: [{ path: "company/skills.list", text: "obra/superpowers@v6.3.0\n" }],
    exec: fakeExec(calls),
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code", "codex"],
    managedFile: file,
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  };
  const r1 = createReporter(() => {}, false);
  expect(await runInstallSkills({ ...deps, reporter: r1 })).toBe(0);
  expect(calls[0]).toEqual([
    process.execPath,
    "/bin/skills",
    "add",
    "obra/superpowers#v6.3.0",
    "-g",
    "-y",
    "-a",
    "claude-code",
    "-a",
    "codex",
  ]);
  expect(r1.counts().installed).toBe(1);
  expect(loadState(file).skills).toEqual({ "obra/superpowers@v6.3.0": ["claude-code", "codex"] });

  // The second run adds again — that is the only way a skill that is new upstream arrives — but
  // nothing moved, so the entry reports ok.
  const r2 = createReporter(() => {}, false);
  expect(await runInstallSkills({ ...deps, reporter: r2 })).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0] ?? []);
  expect(r2.counts()).toMatchObject({ ok: 1, installed: 0 });
});

test("a changed agent set or a changed pin re-runs the install", async () => {
  const calls: string[][] = [];
  const file = managed();
  const base = {
    exec: fakeExec(calls),
    skillsBin: "/bin/skills",
    managedFile: file,
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  };
  await runInstallSkills({
    ...base,
    lists: [{ path: "l", text: "a/b@v1\n" }],
    skillsAgents: ["claude-code"],
    reporter: quiet(),
  });
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    ...base,
    lists: [{ path: "l", text: "a/b@v2\n" }],
    skillsAgents: ["claude-code"],
    reporter: r,
  });
  expect(calls).toHaveLength(2);
  expect(r.counts().updated).toBe(1);
  expect(Object.keys(loadState(file).skills)).toEqual(["a/b@v2"]);
});

test("a URL entry whose pin changes is labeled updated, not installed", async () => {
  const calls: string[][] = [];
  const file = managed();
  const base = {
    exec: fakeExec(calls),
    skillsBin: "/bin/skills",
    managedFile: file,
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  };
  await runInstallSkills({
    ...base,
    lists: [{ path: "l", text: "https://git.x/a/b.git v1\n" }],
    skillsAgents: ["claude-code"],
    reporter: quiet(),
  });
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    ...base,
    lists: [{ path: "l", text: "https://git.x/a/b.git v2\n" }],
    skillsAgents: ["claude-code"],
    reporter: r,
  });
  expect(r.counts()).toMatchObject({ updated: 1, installed: 0 });
  expect(calls[1]).toEqual([
    process.execPath,
    "/bin/skills",
    "add",
    "https://git.x/a/b.git#v2",
    "-g",
    "-y",
    "-a",
    "claude-code",
  ]);
});

test("a failure counts, exits non-zero, and is not recorded", async () => {
  const file = managed();
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "fail/fail@v1\nok/ok@v1\n" }],
    exec: fakeExec([]),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: file,
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(code).toBe(1);
  expect(r.counts()).toMatchObject({ installed: 1, failed: 1 });
  expect(Object.keys(loadState(file).skills)).toEqual(["ok/ok@v1"]);
});

test("a commit hash pin is rejected with the tag advice", async () => {
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    lists: [{ path: "l", text: `a/b@${"f".repeat(40)}\n` }],
    exec: fakeExec([]),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(r.counts().failed).toBe(1);
});

test("an old node fails before any install; no agents skips", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "a/b@v1\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: "v20.12.2",
  });
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  const r2 = createReporter(() => {}, false);
  await runInstallSkills({
    lists: [{ path: "l", text: "a/b@v1\n" }],
    exec: fakeExec(calls),
    reporter: r2,
    skillsBin: "/bin/skills",
    skillsAgents: [],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(r2.counts().skipped).toBe(1);
});

test("--update bumps each GitHub entry to its highest tag and leaves untagged repos alone", async () => {
  const written: Record<string, string> = {};
  const exec: Exec = async (_cmd, args) => {
    if (args.includes("https://github.com/a/b.git"))
      return { code: 0, stdout: "aaa\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.10.0\nccc\trefs/tags/v0.9.0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    lists: [{ path: "company/skills.list", text: "a/b@v1.2.0\nc/d@main\n" }],
    exec,
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
    update: true,
    writeList: (path, text) => {
      written[path] = text;
    },
  });
  expect(written["company/skills.list"]).toBe("a/b@v1.10.0\nc/d@main\n");
  expect(r.counts()).toMatchObject({ updated: 1, skipped: 1 });
});

test("installs a skill that is new in a listed source and reports it", async () => {
  const file = managed();
  const lock = lockFile({ alpha: { source: "a/b", updatedAt: new Date().toISOString() } });
  const calls: string[][] = [];
  const base = {
    lists: [{ path: "l", text: "a/b@v1\n" }],
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: file,
    skillLockFile: lock,
    nodeVersion: NODE,
  };
  await runInstallSkills({ ...base, exec: lockWritingExec(calls, lock, { "a/b": ["alpha"] }), reporter: quiet() });
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    ...base,
    exec: lockWritingExec(calls, lock, { "a/b": ["alpha", "beta"] }),
    reporter: r,
  });
  expect(r.counts()).toMatchObject({ updated: 1, ok: 0 });
  expect(Object.keys(JSON.parse(readFileSync(lock, "utf8")).skills).sort()).toEqual(["alpha", "beta"]);
});

test("removes a skill the add did not stamp, because it is deleted upstream", async () => {
  const file = managed();
  const old = new Date(Date.now() - 60_000).toISOString();
  const lock = lockFile({ alpha: { source: "a/b", updatedAt: old }, beta: { source: "a/b", updatedAt: old } });
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  // The source still provides alpha only. beta keeps its old stamp and is removed.
  await runInstallSkills({
    lists: [{ path: "l", text: "a/b@v1\n" }],
    exec: lockWritingExec(calls, lock, { "a/b": ["alpha"] }),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: file,
    skillLockFile: lock,
    nodeVersion: NODE,
  });
  expect(calls[1]).toEqual([process.execPath, "/bin/skills", "remove", "beta", "-g", "-y", "-a", "claude-code"]);
  expect(Object.keys(JSON.parse(readFileSync(lock, "utf8")).skills)).toEqual(["alpha"]);
  expect(r.counts().failed).toBe(0);
});

test("keeps every skill when the add stamped none of them", async () => {
  const file = managed();
  const old = new Date(Date.now() - 60_000).toISOString();
  const lock = lockFile({ alpha: { source: "a/b", updatedAt: old }, beta: { source: "a/b", updatedAt: old } });
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    lists: [{ path: "l", text: "a/b@v1\n" }],
    exec: lockWritingExec(calls, lock, {}),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: file,
    skillLockFile: lock,
    nodeVersion: NODE,
  });
  expect(calls).toHaveLength(1);
  expect(r.counts().skipped).toBe(1);
  expect(Object.keys(JSON.parse(readFileSync(lock, "utf8")).skills).sort()).toEqual(["alpha", "beta"]);
});

test("removes every skill of a source that no list names any more", async () => {
  const file = managed();
  const lock = lockFile({});
  const calls: string[][] = [];
  const base = {
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: file,
    skillLockFile: lock,
    nodeVersion: NODE,
  };
  const exec = lockWritingExec(calls, lock, { "a/b": ["alpha"], "c/d": ["gamma"] });
  await runInstallSkills({ ...base, lists: [{ path: "l", text: "a/b@v1\nc/d@v1\n" }], exec, reporter: quiet() });
  const r = createReporter(() => {}, false);
  await runInstallSkills({ ...base, lists: [{ path: "l", text: "a/b@v1\n" }], exec, reporter: r });
  expect(calls.at(-1)).toEqual([process.execPath, "/bin/skills", "remove", "gamma", "-g", "-y", "-a", "claude-code"]);
  expect(Object.keys(JSON.parse(readFileSync(lock, "utf8")).skills)).toEqual(["alpha"]);
  expect(loadState(file).skills).toEqual({ "a/b@v1": ["claude-code"] });
});

test("--update bumps a version tag, keeps a branch pin, and rewrites only the entry line", async () => {
  const written: Record<string, string> = {};
  const exec: Exec = async (cmd, args) => {
    if (cmd === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: "abc\trefs/tags/v6.3.0\ndef\trefs/tags/v6.4.0\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const text = [
    "# obra/superpowers@v6.3.0 was chosen because it is stable",
    "obra/superpowers@v6.3.0   # keep this comment",
    "ayghri/i-have-adhd@main",
    "",
  ].join("\n");
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "company/skills.list", text }],
    exec,
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
    update: true,
    writeList: (path, next) => {
      written[path] = next;
    },
  });
  expect(code).toBe(0);
  expect(written["company/skills.list"]).toBe(
    [
      "# obra/superpowers@v6.3.0 was chosen because it is stable",
      "obra/superpowers@v6.4.0   # keep this comment",
      "ayghri/i-have-adhd@main",
      "",
    ].join("\n"),
  );
  expect(r.counts().updated).toBe(1);
  expect(r.counts().skipped).toBe(1);
});

test("an all-digit ref is a tag, not a commit hash", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "acme/skills@20260909\nacme/build@1234567\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(code).toBe(0);
  expect(r.counts().failed).toBe(0);
  expect(calls.filter((c) => c.includes("add")).length).toBe(2);
});

test("rejects a short commit hash as a pin before it reaches the skills CLI", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "acme/skills@1a2b3c4\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(calls.some((c) => c.includes("add"))).toBe(false);
});

test("a missing skills CLI is skipped with a remedy and fails nothing", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "obra/superpowers@v6.3.0\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: undefined,
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(code).toBe(0);
  expect(calls).toEqual([]);
  expect(r.counts().skipped).toBe(1);
  expect(r.counts().failed).toBe(0);
});

test("an unpinned third-party entry is a warning line, not a counted item", async () => {
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  await runInstallSkills({
    lists: [{ path: "l", text: "acme/tools\n" }],
    exec: fakeExec([]),
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(lines.some((l) => l.includes("warning") && l.includes("acme/tools"))).toBe(true);
  expect(r.counts().skipped).toBe(0);
});

test("--update on a URL entry writes the tag after a space, not after an @", async () => {
  const written: Record<string, string> = {};
  const exec: Exec = async (cmd, args) => {
    if (cmd === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: "abc\trefs/tags/v1.0.0\ndef\trefs/tags/v1.1.0\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "company/skills.list", text: "https://git.acme.com/team/skills.git v1.0.0\n" }],
    exec,
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
    update: true,
    writeList: (path, next) => {
      written[path] = next;
    },
  });
  expect(code).toBe(0);
  expect(written["company/skills.list"]).toBe("https://git.acme.com/team/skills.git v1.1.0\n");
  expect(r.counts().updated).toBe(1);
});
