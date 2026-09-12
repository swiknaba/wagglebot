import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MarkdownMemoryProvider } from "./provider";
import { fixtureRepo, memory, writeMemory } from "./test-fixture";

const input = (projectRoot: string) => ({
  projectRoot,
  section: "Warnings" as const,
  title: "Retries can duplicate a charge",
  summary: "Do not retry a timed-out charge until its idempotency record is checked.",
  evidence: [{ kind: "file" as const, ref: "src/payments/charge.ts:74" }],
});

test("save rejects a proposal after concurrent memory editing", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider({ today: () => "2026-09-13" });
  const proposal = await provider.propose(input(repo));
  writeMemory(repo, `${readFileSync(join(repo, ".agents", "memory.md"), "utf8")}\n### Maintainer edit\n\nKeep this.\n`);

  await expect(provider.save({ projectRoot: repo, proposal })).rejects.toMatchObject({ code: "memory_changed" });
});

test("save atomically writes a verified proposal without staging or committing", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider({ today: () => "2026-09-13" });
  const proposal = await provider.propose(input(repo));

  const result = await provider.save({ projectRoot: repo, proposal });

  expect(result).toMatchObject({
    path: ".agents/memory.md",
    action: "add",
    previousContentHash: proposal.baseContentHash,
  });
  expect(readFileSync(join(repo, ".agents", "memory.md"), "utf8")).toContain("### Retries can duplicate a charge");
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo }).stdout.toString()).not.toContain("A  ");
});

test("save replaces only the exact H3 entry selected by its content hash", async () => {
  const repo = fixtureRepo();
  writeMemory(
    repo,
    memory("Use local state.").replace(
      "## Warnings\n\nDo not retry writes.",
      "## Warnings\n\n### Retries can duplicate a charge\n\nOld warning text.\n",
    ),
  );
  const provider = new MarkdownMemoryProvider({ today: () => "2026-09-13" });
  const existing = (await provider.read(repo))?.chunks.find(
    (chunk) => chunk.headingPath.join(" / ") === "Warnings / Retries can duplicate a charge",
  );
  expect(existing).toBeDefined();

  const proposal = await provider.propose({
    ...input(repo),
    replace: { title: "Retries can duplicate a charge", contentHash: existing?.contentHash ?? "" },
  });
  const result = await provider.save({ projectRoot: repo, proposal });

  expect(result.action).toBe("replace");
  const saved = readFileSync(join(repo, ".agents", "memory.md"), "utf8");
  expect(saved).toContain("Do not retry a timed-out charge");
  expect(saved).not.toContain("Old warning text.");
});

test("save rejects tampered proposals", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider({ today: () => "2026-09-13" });
  const proposal = await provider.propose(input(repo));

  await expect(
    provider.save({ projectRoot: repo, proposal: { ...proposal, proposalId: "tampered" } }),
  ).rejects.toMatchObject({
    code: "proposal_invalid",
  });
});

test("a failed atomic write leaves the original memory intact", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider({
    today: () => "2026-09-13",
    write: () => {
      throw new Error("disk full");
    },
  });
  const proposal = await provider.propose(input(repo));
  const before = readFileSync(join(repo, ".agents", "memory.md"), "utf8");

  await expect(provider.save({ projectRoot: repo, proposal })).rejects.toMatchObject({ code: "local_brain_internal" });
  expect(readFileSync(join(repo, ".agents", "memory.md"), "utf8")).toBe(before);
});
