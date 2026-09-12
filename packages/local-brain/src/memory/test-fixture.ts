import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fixtureRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wagglebot-memory-"));
  Bun.spawnSync(["git", "init", root]);
  return root;
};

export const writeMemory = (root: string, text: string): void => {
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "memory.md"), text);
};

export const memory = (body: string): string =>
  `# Component Memory\n\n## Architecture\n\n${body}\n\n## Conventions\n\nUse Bun.\n\n## Commands\n\nRun bun test.\n\n## Decisions\n\nUse SQLite.\n\n## Warnings\n\nDo not retry writes.\n\n## Learnings\n\nKeep facts concise.\n`;
