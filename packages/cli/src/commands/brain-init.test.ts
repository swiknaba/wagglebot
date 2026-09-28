import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBrainInit } from "./brain-init";

const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wgl-brain-init-"));
  mkdirSync(join(root, ".git"));
  return root;
};

const fakeBrain = (hooks: { initialize?: () => void; close?: () => void } = {}) => ({
  identify: async () => ({ workingTree: "clean" as const, catalogState: "missing" as const }),
  code: {
    initialize: async () => {
      hooks.initialize?.();
      return { state: "ready" as const, pendingFiles: [], observedAt: "now" };
    },
  },
  close: async () => hooks.close?.(),
});

test("brain init creates the local bundle and managed CodeGraph ignore block once", async () => {
  const root = repo();
  const lines: string[] = [];
  expect(await runBrainInit({ projectPath: root, brain: fakeBrain(), write: (line) => lines.push(line) })).toBe(0);
  const first = readFileSync(join(root, ".agents/memory/component.md"), "utf8");
  expect(readFileSync(join(root, ".agents/memory/index.md"), "utf8")).toContain('okf_version: "0.2"');
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(first).toContain("# Component Overview");
  expect(lines).toContain("Component memory  ready  .agents/memory/");
  expect(lines).toContain("Code graph         ready");
  expect(ignore).toContain("# wagglebot:begin local-brain");
  expect(await runBrainInit({ projectPath: root, brain: fakeBrain(), write: () => undefined })).toBe(0);
  expect(readFileSync(join(root, ".agents/memory/component.md"), "utf8")).toBe(first);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ignore);
});

test("brain init preserves concepts, repairs indexes, and closes after CodeGraph initialization", async () => {
  const root = repo();
  const memory =
    "---\ntype: Warning\ntitle: Retry safely\n---\n\nRetry writes only after checking their idempotency.\n";
  mkdirSync(join(root, ".agents/memory/warnings"), { recursive: true });
  writeFileSync(join(root, ".agents/memory/warnings/retries.md"), memory);
  writeFileSync(join(root, ".agents/memory/index.md"), '---\nokf_version: "0.2"\n---\n\n# Stale index\n');
  const order: string[] = [];

  expect(
    await runBrainInit({
      projectPath: root,
      brain: fakeBrain({ initialize: () => order.push("initialize"), close: () => order.push("close") }),
      write: () => undefined,
    }),
  ).toBe(0);

  expect(readFileSync(join(root, ".agents/memory/warnings/retries.md"), "utf8")).toBe(memory);
  expect(readFileSync(join(root, ".agents/memory/index.md"), "utf8")).toContain("warnings/index.md");
  expect(readFileSync(join(root, ".agents/memory/warnings/index.md"), "utf8")).toContain("Retry safely");
  expect(readFileSync(join(root, ".agents/memory/index.md"), "utf8")).not.toContain("# Stale index");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("# wagglebot:begin local-brain");
  expect(order).toEqual(["initialize", "close"]);
});
