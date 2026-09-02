import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runSyncAgents } from "./sync-agents";

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const instructionsDir = join(home, "company-instructions");
  mkdirSync(instructionsDir);
  writeFileSync(join(instructionsDir, "10-team.md"), "## Team Instructions\n");
  return { home, instructionsDir };
};
const quiet = () => createReporter(() => {}, false);

test("writes every template target inside a managed block, chmod 600", () => {
  const { home, instructionsDir } = setup();
  const code = runSyncAgents({ home, instructionsDir, reporter: quiet() });
  expect(code).toBe(0);
  const claude = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(claude).toContain("<!-- wagglebot:begin -->");
  expect(claude).toContain("## Team Instructions");
  expect(claude).toContain("## Memory");
  expect(statSync(join(home, ".claude/CLAUDE.md")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(home, ".gemini/config/rules/global.md"))).toBe(true);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(JSON.stringify(settings.hooks)).toContain("wagglebot:");
});

test("second run reports every item ok and changes nothing", () => {
  const { home, instructionsDir } = setup();
  runSyncAgents({ home, instructionsDir, reporter: quiet() });
  const before = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  const r = createReporter(() => {}, false);
  expect(runSyncAgents({ home, instructionsDir, reporter: r })).toBe(0);
  expect(r.counts().updated).toBe(0);
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe(before);
});

test("content outside the managed block survives, and --restore brings the old file back", () => {
  const { home, instructionsDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# My personal rules\n");
  runSyncAgents({ home, instructionsDir, reporter: quiet() });
  const synced = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(synced.startsWith("# My personal rules")).toBe(true);
  runSyncAgents({ home, instructionsDir, reporter: quiet(), options: { restore: true } });
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# My personal rules\n");
});

test("a corrupt settings.json fails the hooks merge but other targets still get written", () => {
  const { home, instructionsDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), "{ not valid json");
  const r = createReporter(() => {}, false);
  const code = runSyncAgents({ home, instructionsDir, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBeGreaterThan(0);
  // The CLAUDE.md target (a separate harness target) still gets written.
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
  expect(existsSync(join(home, ".gemini/config/rules/global.md"))).toBe(true);
});

test("--dry-run changes nothing", () => {
  const { home, instructionsDir } = setup();
  runSyncAgents({ home, instructionsDir, reporter: quiet(), options: { dryRun: true } });
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
});
