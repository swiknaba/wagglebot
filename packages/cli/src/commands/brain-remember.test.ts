import { expect, test } from "bun:test";

import type { LocalMemoryProposal, LocalMemorySaveResult } from "@wagglebot/local-brain";
import { runBrainRemember } from "./brain-remember";

const proposal = (title: string): LocalMemoryProposal => ({
  proposalId: "proposal-id",
  baseBundleHash: "a".repeat(64),
  path: ".agents/memory/warnings/retry-rule.md",
  section: "Warnings",
  title,
  summary: "Check the idempotency record.",
  evidence: [{ kind: "file", ref: "src/a.ts:1" }],
  action: "add",
  content: "---\ntype: Warning\n---\n\n# Warning\n",
  indexChanges: [{ path: ".agents/memory/index.md", content: "# Component Memory\n" }],
  patch: "+ entry",
  warnings: [],
});

const result: LocalMemorySaveResult = {
  path: ".agents/memory/warnings/retry-rule.md",
  action: "add",
  previousBundleHash: "a".repeat(64),
  newBundleHash: "b".repeat(64),
  patch: "+ entry",
  warnings: [],
};

const memoryBrain = (saved: string[], saveResult = result) => ({
  memory: {
    propose: async (input: { title: string }) => proposal(input.title),
    save: async ({ proposal: submitted }: { proposal: LocalMemoryProposal }) => {
      saved.push(submitted.proposalId);
      return saveResult;
    },
  },
});

test("brain remember previews without saving and reports the saved OKF path and bundle hash", async () => {
  const saved: string[] = [];
  const args = {
    projectPath: "/repo",
    section: "Warnings" as const,
    title: "Retry rule",
    summary: "Check the idempotency record.",
    evidence: [{ kind: "file" as const, ref: "src/a.ts:1" }],
  };
  const preview: string[] = [];
  expect(
    await runBrainRemember({ ...args, brain: memoryBrain(saved), save: false, write: (line) => preview.push(line) }),
  ).toBe(0);
  expect(saved).toEqual([]);
  expect(preview.join("\n")).toContain("+ entry");

  const savedOutput: string[] = [];
  expect(
    await runBrainRemember({ ...args, brain: memoryBrain(saved), save: true, write: (line) => savedOutput.push(line) }),
  ).toBe(0);
  expect(saved).toEqual(["proposal-id"]);
  expect(savedOutput.join("\n")).toContain(".agents/memory/warnings/retry-rule.md");
  expect(savedOutput.join("\n")).toContain("b".repeat(64));
});

test("brain remember surfaces stale-index warnings without claiming the full patch was applied", async () => {
  const saved: string[] = [];
  const saveResult: LocalMemorySaveResult = { ...result, warnings: ["indexes_stale"] };
  const output: string[] = [];
  const code = await runBrainRemember({
    projectPath: "/repo",
    section: "Warnings",
    title: "Retry rule",
    summary: "Check the idempotency record.",
    evidence: [{ kind: "file", ref: "src/a.ts:1" }],
    save: true,
    brain: memoryBrain(saved, saveResult),
    write: (line) => output.push(line),
  });
  expect(code).toBe(0);
  expect(output.join("\n")).toContain("Warning: indexes_stale");
  expect(output.join("\n")).toContain("Saved concept .agents/memory/warnings/retry-rule.md");
  expect(output.join("\n")).not.toContain("Applied entire patch");
});
