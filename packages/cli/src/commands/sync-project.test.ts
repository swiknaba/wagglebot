import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES } from "../harness";
import { createReporter } from "../report";
import { INSTRUCTIONS_DIR, projectTargets, readInstructionSources, runSyncProject } from "./sync-project";

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
  expect(lines.some((l) => l.includes("skipped"))).toBe(true);
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

test("a malformed lone begin marker aborts before any other target is created", () => {
  const { repo, instructionsDir } = setupRepo();
  writeFileSync(join(instructionsDir, "a.md"), "A content\n");
  writeFileSync(join(repo, "CLAUDE.md"), "<!-- wagglebot:begin -->\nstuff\n");
  expect(() => runSyncProject({ cwd: repo, reporter: quiet() })).toThrow();
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(repo, "GEMINI.md"))).toBe(false);
  expect(existsSync(join(repo, ".github/copilot-instructions.md"))).toBe(false);
});

test("projectTargets merges harnesses that share one path", () => {
  const targets = projectTargets(HARNESSES);
  expect(targets).toHaveLength(4);
  const agents = targets.find((t) => t.relative === "AGENTS.md");
  expect(agents?.harnesses).toEqual(["codex", "junie", "cline"]);
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
