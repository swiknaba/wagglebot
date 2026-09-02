import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { createReporter } from "../report";
import { runInstallAgents } from "./install-agents";

const quiet = () => createReporter(() => {}, false);

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
    listTexts: [{ path: "agents.base.list", text: "acme/agents@abc1234\n" }],
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
  await runInstallAgents({ home, listTexts: lists, exec: fakeGit, reporter: quiet() });
  const r = createReporter(() => {}, false);
  await runInstallAgents({ home, listTexts: lists, exec: fakeGit, reporter: r });
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(r.counts().installed).toBe(0);
  await runInstallAgents({
    home,
    listTexts: [{ path: "agents.base.list", text: "" }],
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(existsSync(join(home, ".claude/agents/acme__agents__reviewer.md"))).toBe(false);
});

test("a failing pull on an unpinned, already-cached entry reports failed and keeps the file installed", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const unpinned = [{ path: "agents.base.list", text: "acme/agents\n" }];
  // First run: clone succeeds, materializing reviewer.md and installing it.
  await runInstallAgents({ home, listTexts: unpinned, exec: fakeGit, reporter: quiet() });
  const installed = join(home, ".claude/agents/acme__agents__reviewer.md");
  expect(existsSync(installed)).toBe(true);

  // Second run: the cache dir already exists, so materialize() takes the "pull" branch,
  // which now fails. A transient git failure must not uninstall the previously installed file.
  const failingPull: Exec = async (cmd, args) => {
    if (cmd === "git" && args.includes("pull")) return { code: 1, stdout: "", stderr: "not fast-forward" };
    return fakeGit(cmd, args);
  };
  const r = createReporter(() => {}, false);
  const code = await runInstallAgents({ home, listTexts: unpinned, exec: failingPull, reporter: r });
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
    listTexts: [],
    companyAgentsDir,
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(code).toBe(0);
  expect(readFileSync(join(home, ".claude/agents/company__reviewer.md"), "utf8")).toBe("# Company reviewer agent\n");
  expect(existsSync(join(home, ".claude/agents/company__README.md"))).toBe(false);
});

test("removing a file from the company agents/ directory uninstalls it on the next run", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const companyAgentsDir = mkdtempSync(join(tmpdir(), "wgl-co-agents-"));
  writeFileSync(join(companyAgentsDir, "reviewer.md"), "# Company reviewer agent\n");
  await runInstallAgents({ home, listTexts: [], companyAgentsDir, exec: fakeGit, reporter: quiet() });
  const installed = join(home, ".claude/agents/company__reviewer.md");
  expect(existsSync(installed)).toBe(true);

  rmSync(join(companyAgentsDir, "reviewer.md"));
  await runInstallAgents({ home, listTexts: [], companyAgentsDir, exec: fakeGit, reporter: quiet() });
  expect(existsSync(installed)).toBe(false);
});
