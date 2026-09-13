import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBrainInit } from "./brain-init";

const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wgl-brain-init-"));
  mkdirSync(join(root, ".git"));
  return root;
};

const fakeBrain = () => ({
  identify: async () => ({ workingTree: "clean" as const, catalogState: "missing" as const }),
  memory: {
    read: async (root: string) => (existsSync(join(root, ".agents/memory.md")) ? { contentHash: "hash" } : undefined),
  },
  code: { initialize: async () => ({ state: "ready" as const, pendingFiles: [], observedAt: "now" }) },
});

test("brain init creates the memory template and managed CodeGraph ignore block once", async () => {
  const root = repo();
  expect(await runBrainInit({ projectPath: root, brain: fakeBrain(), write: () => undefined })).toBe(0);
  const first = readFileSync(join(root, ".agents/memory.md"), "utf8");
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(first).toContain("# Component Memory");
  expect(ignore).toContain("# wagglebot:begin local-brain");
  expect(await runBrainInit({ projectPath: root, brain: fakeBrain(), write: () => undefined })).toBe(0);
  expect(readFileSync(join(root, ".agents/memory.md"), "utf8")).toBe(first);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ignore);
});

test("brain init never overwrites existing memory", async () => {
  const root = repo();
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/memory.md"), "# Reviewed memory\n");
  expect(await runBrainInit({ projectPath: root, brain: fakeBrain(), write: () => undefined })).toBe(0);
  expect(readFileSync(join(root, ".agents/memory.md"), "utf8")).toBe("# Reviewed memory\n");
});
