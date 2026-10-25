import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HARNESSES } from "../harness";
import { createReporter } from "../report";
import {
  PROJECT_INSTRUCTIONS_DIR as INSTRUCTIONS_DIR,
  PROJECT_CHANGELOG_FILE,
  projectTargets,
  readInstructionSources,
  runProjectUpdate as runSyncProject,
} from "./project-update";

const quiet = () => createReporter(() => {}, false);

function setupRepo(): { repo: string; instructionsDir: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-repo-")));
  mkdirSync(join(repo, ".git"));
  const instructionsDir = join(repo, INSTRUCTIONS_DIR);
  mkdirSync(instructionsDir, { recursive: true });
  return { repo, instructionsDir };
}

test("first run creates every project target with sources in name order", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "10-code-style.md"), "## Code style\nUse tabs.\n");
  writeFileSync(join(instructionsDir, "20-testing.md"), "## Testing\nWrite tests.\n");

  const code = runSyncProject({ cwd: repo, reporter: quiet() });
  expect(code).toBe(0);
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(repo, "GEMINI.md"))).toBe(true);
  expect(existsSync(join(repo, ".github/copilot-instructions.md"))).toBe(true);
  expect(existsSync(join(repo, "CLAUDE.md"))).toBe(true);

  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  const begin = agents.indexOf("<!-- wagglebot:begin -->");
  const end = agents.indexOf("<!-- wagglebot:end -->");
  expect(begin).toBeGreaterThanOrEqual(0);
  const codeStyleIdx = agents.indexOf("## Code style");
  const testingIdx = agents.indexOf("## Testing");
  expect(codeStyleIdx).toBeGreaterThan(begin);
  expect(codeStyleIdx).toBeLessThan(testingIdx);
  expect(testingIdx).toBeLessThan(end);

  expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  expect(readFileSync(join(repo, "GEMINI.md"), "utf8")).toContain("@./AGENTS.md");
});

test("second run reports every item ok and changes nothing", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A\n");
  writeFileSync(join(instructionsDir, "b.md"), "B\n");
  runSyncProject({ cwd: repo, reporter: quiet() });
  const before = readFileSync(join(repo, "AGENTS.md"), "utf8");

  const r = createReporter(() => {}, false);
  const code = runSyncProject({ cwd: repo, reporter: r });
  expect(code).toBe(0);
  expect(r.counts().updated).toBe(0);
  expect(r.counts().installed).toBe(0);
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(before);
});

test("a pre-existing CLAUDE.md keeps its user text before the block", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# My rules\n");
  runSyncProject({ cwd: repo, reporter: quiet() });

  const claude = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  expect(claude.startsWith("# My rules")).toBe(true);
  expect(claude).toContain("@AGENTS.md");
});

test("editing a source file updates every block target and preserves content outside the block", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A v1\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# My rules\n");
  runSyncProject({ cwd: repo, reporter: quiet() });

  writeFileSync(join(instructionsDir, "a.md"), "A v2\n");
  runSyncProject({ cwd: repo, reporter: quiet() });

  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  expect(agents).toContain("A v2");
  expect(agents).not.toContain("A v1");
  const claude = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  expect(claude.startsWith("# My rules")).toBe(true);
  expect(claude).toContain("@AGENTS.md");
});

test("removing one source removes only its stale text from AGENTS.md", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A content\n");
  writeFileSync(join(instructionsDir, "b.md"), "B content\n");
  runSyncProject({ cwd: repo, reporter: quiet() });

  rmSync(join(instructionsDir, "b.md"));
  runSyncProject({ cwd: repo, reporter: quiet() });

  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  expect(agents).toContain("A content");
  expect(agents).not.toContain("B content");
});

test("removing the last source deletes generated files but keeps a pre-existing file's user text", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A content\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# My rules\n");
  runSyncProject({ cwd: repo, reporter: quiet() });

  rmSync(join(instructionsDir, "a.md"));
  const code = runSyncProject({ cwd: repo, reporter: quiet() });
  expect(code).toBe(0);
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(repo, "GEMINI.md"))).toBe(false);
  expect(existsSync(join(repo, ".github/copilot-instructions.md"))).toBe(false);
  expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# My rules\n");
});

test("no source and no managed block does nothing and reports skipped", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-repo-")));
  mkdirSync(join(repo, ".git"));
  const lines: string[] = [];
  const code = runSyncProject({ cwd: repo, reporter: createReporter((l) => lines.push(l), false) });
  expect(code).toBe(0);
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  const skipped = lines.find((line) => line.includes("skipped"));
  expect(skipped).toContain("no instruction targets changed");
  expect(skipped).not.toContain("nothing changes");
});

test("a generated file a user appended to keeps the appended text and loses only the block when sources are gone", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A content\n");
  runSyncProject({ cwd: repo, reporter: quiet() });

  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  writeFileSync(join(repo, "AGENTS.md"), `${agents}\nUser addition\n`);

  rmSync(join(instructionsDir, "a.md"));
  const code = runSyncProject({ cwd: repo, reporter: quiet() });
  expect(code).toBe(0);
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
  const after = readFileSync(join(repo, "AGENTS.md"), "utf8");
  expect(after).not.toContain("<!-- wagglebot:begin -->");
  expect(after).toContain("User addition");
});

test("a source file above the Codex budget warns with the byte count and does not claim a smaller file fits", () => {
  const { repo, instructionsDir } = setupRepo();
  const big = "x".repeat(40 * 1024);
  writeFileSync(join(instructionsDir, "big.md"), `${big}\n`);
  const lines: string[] = [];
  const code = runSyncProject({ cwd: repo, reporter: createReporter((l) => lines.push(l), false) });
  expect(code).toBe(0);

  const agentsBytes = Buffer.byteLength(readFileSync(join(repo, "AGENTS.md"), "utf8"), "utf8");
  const warningLine = lines.find((l) => l.toLowerCase().includes("warning"));
  expect(warningLine).toBeDefined();
  expect(warningLine ?? "").toContain(String(agentsBytes));
  expect(warningLine ?? "").toContain("32768");
  expect(warningLine ?? "").toMatch(/cannot|may not fit/);
});

test("a small source produces no warning", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "small\n");
  const lines: string[] = [];
  runSyncProject({ cwd: repo, reporter: createReporter((l) => lines.push(l), false) });
  expect(lines.some((l) => l.toLowerCase().includes("warning"))).toBe(false);
});

test("a malformed later target aborts before earlier targets or memory scaffolding change", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A content\n");
  const claude = "# Personal Claude instructions\n";
  const malformed = "<!-- wagglebot:begin -->\nstuff\n";
  writeFileSync(join(repo, "CLAUDE.md"), claude);
  writeFileSync(join(repo, "AGENTS.md"), malformed);
  expect(() => runSyncProject({ cwd: repo, reporter: quiet() })).toThrow();
  expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(claude);
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(malformed);
  expect(existsSync(join(repo, "GEMINI.md"))).toBe(false);
  expect(existsSync(join(repo, ".github/copilot-instructions.md"))).toBe(false);
  expect(existsSync(join(repo, ".agents/memory"))).toBe(false);
  expect(existsSync(join(repo, PROJECT_CHANGELOG_FILE))).toBe(false);
});

test("projectTargets merges harnesses that share one path", () => {
  const targets = projectTargets(HARNESSES);
  expect(targets).toHaveLength(4);
  const agents = targets.find((t) => t.relative === "AGENTS.md");
  expect(agents?.harnesses).toEqual(["codex", "junie", "cline", "cursor", "devin", "kiro"]);
  expect(agents?.warnBytes).toBe(32 * 1024);
  const claude = targets.find((t) => t.relative === "CLAUDE.md");
  expect(claude?.mode).toBe("import");
  expect(claude?.importLine).toBe("@AGENTS.md");
});

test("readInstructionSources ignores non-md and whitespace-only files, and sorts by name", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-repo-")));
  const dir = join(repo, INSTRUCTIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "b.md"), "B\n");
  writeFileSync(join(dir, "a.md"), "A\n");
  writeFileSync(join(dir, "notes.txt"), "ignored\n");
  writeFileSync(join(dir, "empty.md"), "   \n\t\n");
  expect(readInstructionSources(repo)).toEqual(["A", "B"]);
});

test("readInstructionSources returns [] when the directory is missing", () => {
  const repo = mkdtempSync(join(tmpdir(), "wgl-repo-"));
  expect(readInstructionSources(repo)).toEqual([]);
});

test("running from a nested subdirectory finds the same root", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A\n");
  const nested = join(repo, "src", "deep");
  mkdirSync(nested, { recursive: true });
  const code = runSyncProject({ cwd: nested, reporter: quiet() });
  expect(code).toBe(0);
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
});

test("running outside a Git repository throws mentioning Git repository", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wgl-noGit-")));
  expect(() => runSyncProject({ cwd: outside, reporter: quiet() })).toThrow(/Git repository/);
});

test("project update creates missing memory and changelog without instruction sources", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-repo-")));
  mkdirSync(join(repo, ".git"));

  expect(runSyncProject({ cwd: repo, reporter: quiet() })).toBe(0);

  expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).toContain('okf_version: "0.2"');
  expect(readFileSync(join(repo, ".agents/memory/component.md"), "utf8")).toContain("# Component Overview");
  expect(existsSync(join(repo, ".agents/memory.md"))).toBe(false);
  expect(readFileSync(join(repo, PROJECT_CHANGELOG_FILE), "utf8")).toBe(
    "# Agent Changelog\n\n<!-- Add dated Added, Changed, Fixed, or Removed sections after meaningful repository changes. -->\n",
  );
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(repo, "catalog-info.yaml"))).toBe(false);
  expect(existsSync(join(repo, ".gitignore"))).toBe(false);
});

test("project update preserves memory and changelog bytes and excludes other agent files from published instructions", () => {
  const { repo, instructionsDir } = setupRepo();
  const memory = "---\ntype: Architecture\ntitle: Private architecture\n---\n\nPrivate concept sentinel.\n";
  const memoryPath = join(repo, ".agents/memory/architecture/boundaries.md");
  mkdirSync(join(repo, ".agents/memory/architecture"), { recursive: true });
  writeFileSync(memoryPath, memory);
  writeFileSync(join(repo, ".agents/memory/index.md"), '---\nokf_version: "0.2"\n---\n\n# Stale index\n');
  const changelog = "changelog\r\ntext sentinel\n";
  writeFileSync(join(repo, PROJECT_CHANGELOG_FILE), changelog);
  mkdirSync(join(repo, ".agents", "subagents"), { recursive: true });
  writeFileSync(join(repo, ".agents", "subagents", "reviewer.md"), "never publish this");
  writeFileSync(join(instructionsDir, "only-source.md"), "publish this");

  expect(runSyncProject({ cwd: repo, reporter: quiet() })).toBe(0);

  expect(readFileSync(memoryPath, "utf8")).toBe(memory);
  expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).toContain("architecture/index.md");
  expect(readFileSync(join(repo, ".agents/memory/architecture/index.md"), "utf8")).toContain("Private architecture");
  expect(readFileSync(join(repo, ".agents/memory/index.md"), "utf8")).not.toContain("# Stale index");
  expect(readFileSync(join(repo, PROJECT_CHANGELOG_FILE), "utf8")).toBe(changelog);
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  expect(agents).toContain("publish this");
  expect(agents).not.toContain("Private concept sentinel");
  expect(agents).not.toContain("text sentinel");
  expect(agents).not.toContain("never publish this");
  expect(agents).toContain("wagglebot update");
  expect(agents).not.toContain("wagglebot sync-project");
});

test("a legacy memory file rejects project update before any instruction target changes", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "New managed instruction.\n");
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents/memory.md"), "# Old memory\n");

  const targets = projectTargets(HARNESSES);
  for (const target of targets) {
    const absolute = join(repo, target.relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `Personal ${target.relative}\n`);
  }
  const before = targets.map((target) => readFileSync(join(repo, target.relative), "utf8"));
  let thrown: unknown;
  try {
    runSyncProject({ cwd: repo, reporter: quiet() });
  } catch (error) {
    thrown = error;
  }

  expect((thrown as { code?: string } | undefined)?.code).toBe("local_memory_invalid");
  expect(targets.map((target) => readFileSync(join(repo, target.relative), "utf8"))).toEqual(before);
  expect(existsSync(join(repo, ".agents/memory"))).toBe(false);
  expect(existsSync(join(repo, PROJECT_CHANGELOG_FILE))).toBe(false);
});
