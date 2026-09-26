import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { stringify } from "yaml";

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

export const conceptText = (input?: {
  type?: string;
  title?: string;
  description?: string;
  body?: string;
  extra?: string;
}): string => {
  const frontmatter = stringify(
    {
      type: input?.type ?? "Warning",
      ...(input?.title === undefined ? {} : { title: input.title }),
      ...(input?.description === undefined ? {} : { description: input.description }),
    },
    { lineWidth: 0 },
  ).trimEnd();
  const extra = input?.extra === undefined ? "" : `\n${input.extra}`;
  const body = input?.body ?? "Do not retry writes.";
  return `---\n${frontmatter}${extra}\n---\n\n${body}\n`;
};

export const writeConcept = (root: string, relative: string, text: string): string => {
  const path = resolve(root, ".agents", "memory", relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
