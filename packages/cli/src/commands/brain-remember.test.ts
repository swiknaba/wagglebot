import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBrainRemember } from "./brain-remember";

const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "wgl-brain-remember-"));
  mkdirSync(join(value, ".git"));
  mkdirSync(join(value, ".agents"));
  writeFileSync(join(value, ".agents/memory.md"), "# Component Memory\n\n## Warnings\n");
  return value;
};

const memoryBrain = (saved: string[]) => ({
  memory: {
    propose: async (input: { title: string }) => ({
      proposalId: "proposal",
      baseContentHash: "base",
      section: "Warnings" as const,
      title: input.title,
      summary: "summary",
      evidence: [{ kind: "file" as const, ref: "src/a.ts:1" }],
      action: "add" as const,
      patch: "+ entry",
      warnings: [],
    }),
    save: async ({ proposal }: { proposal: { proposalId: string } }) => {
      saved.push(proposal.proposalId);
      return {
        path: ".agents/memory.md" as const,
        action: "add" as const,
        previousContentHash: "base",
        newContentHash: "new",
        patch: "+ entry",
      };
    },
  },
});

test("brain remember previews without saving and saves only with explicit save", async () => {
  const saved: string[] = [];
  const repo = root();
  const args = {
    projectPath: repo,
    section: "Warnings" as const,
    title: "Retry rule",
    summary: "summary",
    evidence: [{ kind: "file" as const, ref: "src/a.ts:1" }],
  };
  const preview: string[] = [];
  expect(
    await runBrainRemember({ ...args, brain: memoryBrain(saved), save: false, write: (line) => preview.push(line) }),
  ).toBe(0);
  expect(saved).toEqual([]);
  expect(preview.join("\n")).toContain("+ entry");
  expect(await runBrainRemember({ ...args, brain: memoryBrain(saved), save: true, write: () => undefined })).toBe(0);
  expect(saved).toEqual(["proposal"]);
  expect(readFileSync(join(repo, ".agents/memory.md"), "utf8")).toContain("# Component Memory");
});
