import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./index";

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

test("--help explains what update touches, file by file", async () => {
  const lines: string[] = [];
  const code = await main(["--help"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  const text = lines.join("\n");
  for (const fragment of [
    "update",
    "init",
    "install-skills",
    "install-agents",
    "sync-agents",
    "~/.claude/CLAUDE.md",
    "~/.claude/settings.json",
    "~/.claude.json",
    "~/.claude/agents/",
    "~/.codex/AGENTS.md",
    "~/.copilot/copilot-instructions.md",
    "<!-- wagglebot:begin -->",
    "~/.wagglebot/managed.json",
    "~/.wagglebot/backups/",
  ]) {
    expect(text).toContain(fragment);
  }
});

test("update --help prints the same help", async () => {
  const lines: string[] = [];
  expect(await main(["update", "--help"], { write: (l) => lines.push(l) })).toBe(0);
  expect(lines.join("\n")).toContain("managed");
});

test("update outside a company repo fails cleanly with guidance, no thrown stack trace", async () => {
  const deep = mkdtempSync(join(tmpdir(), "wgl-deep-"));
  const nested = join(deep, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  const lines: string[] = [];
  const code = await main(["update"], { write: (l) => lines.push(l), cwd: nested });
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("init");
});
