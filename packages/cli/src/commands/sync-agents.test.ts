import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runSyncAgents } from "./sync-agents";

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const overlaysDir = join(home, "company-overlays");
  mkdirSync(overlaysDir);
  writeFileSync(join(overlaysDir, "10-team.md"), "## Team Overlay\n");
  return { home, overlaysDir };
};
const quiet = () => createReporter(() => {}, false);

test("writes every template target inside a managed block, chmod 600", () => {
  const { home, overlaysDir } = setup();
  const code = runSyncAgents({ home, overlaysDir, reporter: quiet() });
  expect(code).toBe(0);
  const claude = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(claude).toContain("<!-- wagglebot:begin -->");
  expect(claude).toContain("## Team Overlay");
  expect(claude).toContain("## Memory");
  expect(statSync(join(home, ".claude/CLAUDE.md")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(home, ".gemini/config/rules/global.md"))).toBe(true);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(JSON.stringify(settings.hooks)).toContain("wagglebot:");
});

test("second run reports every item ok and changes nothing", () => {
  const { home, overlaysDir } = setup();
  runSyncAgents({ home, overlaysDir, reporter: quiet() });
  const before = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  const r = createReporter(() => {}, false);
  expect(runSyncAgents({ home, overlaysDir, reporter: r })).toBe(0);
  expect(r.counts().updated).toBe(0);
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe(before);
});

test("content outside the managed block survives, and --restore brings the old file back", () => {
  const { home, overlaysDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# My personal rules\n");
  runSyncAgents({ home, overlaysDir, reporter: quiet() });
  const synced = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(synced.startsWith("# My personal rules")).toBe(true);
  runSyncAgents({ home, overlaysDir, reporter: quiet(), options: { restore: true } });
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# My personal rules\n");
});

test("--dry-run changes nothing", () => {
  const { home, overlaysDir } = setup();
  runSyncAgents({ home, overlaysDir, reporter: quiet(), options: { dryRun: true } });
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
});
