import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { parseList } from "../lists";
import { createReporter } from "../report";
import { loadState } from "../state";
import { nodeSatisfies, runInstallSkills, toSkillsSource } from "./install-skills";

const quiet = () => createReporter(() => {}, false);
const managed = () => join(mkdtempSync(join(tmpdir(), "wgl-sk-")), "managed.json");
const NODE = "v24.0.0";

const fakeExec =
  (calls: string[][]): Exec =>
  async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "fail/fail#v1") return { code: 1, stdout: "■ Installation failed", stderr: "" };
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
    nodeVersion: NODE,
  };
  const r1 = createReporter(() => {}, false);
  expect(await runInstallSkills({ ...deps, reporter: r1 })).toBe(0);
  expect(calls[0]).toEqual([
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

  const r2 = createReporter(() => {}, false);
  expect(await runInstallSkills({ ...deps, reporter: r2 })).toBe(0);
  expect(calls).toHaveLength(1);
  expect(r2.counts()).toMatchObject({ ok: 1, installed: 0 });
});

test("a changed agent set or a changed pin re-runs the install", async () => {
  const calls: string[][] = [];
  const file = managed();
  const base = { exec: fakeExec(calls), skillsBin: "/bin/skills", managedFile: file, nodeVersion: NODE };
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
  const base = { exec: fakeExec(calls), skillsBin: "/bin/skills", managedFile: file, nodeVersion: NODE };
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
  expect(calls[1]).toEqual(["/bin/skills", "add", "https://git.x/a/b.git#v2", "-g", "-y", "-a", "claude-code"]);
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
    nodeVersion: NODE,
    update: true,
    writeList: (path, text) => {
      written[path] = text;
    },
  });
  expect(written["company/skills.list"]).toBe("a/b@v1.10.0\nc/d@main\n");
  expect(r.counts()).toMatchObject({ updated: 1, skipped: 1 });
});
