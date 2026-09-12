import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LocalBrainError } from "../path-policy";
import { MarkdownMemoryProvider } from "./provider";
import { fixtureRepo, memory, writeMemory } from "./test-fixture";

const proposalInput = (projectRoot: string) => ({
  projectRoot,
  section: "Warnings" as const,
  title: "Retries can duplicate a charge",
  summary: "Do not retry a timed-out charge until its idempotency record is checked.",
  evidence: [{ kind: "file" as const, ref: "src/payments/charge.ts:74" }],
});

test("an explicit finished fact becomes a reviewable proposal without writing", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider({ today: () => "2026-09-13" });
  const before = readFileSync(join(repo, ".agents", "memory.md"), "utf8");

  const proposal = await provider.propose(proposalInput(repo));

  expect(proposal.action).toBe("add");
  expect(proposal.patch).toContain("+### Retries can duplicate a charge");
  expect(readFileSync(join(repo, ".agents", "memory.md"), "utf8")).toBe(before);
  expect(JSON.stringify(proposal)).not.toContain("chat");
});

test("duplicate and conflicting facts cannot create a writable proposal", async () => {
  const repo = fixtureRepo();
  writeMemory(
    repo,
    memory("Use local state.").replace(
      "## Warnings\n\nDo not retry writes.",
      "## Warnings\n\nDo not retry writes.\n\n### Retries can duplicate a charge\n\nDo not retry a timed-out charge until its idempotency record is checked.\n\n- Evidence: `src/payments/charge.ts:74`\n- Added: 2026-09-13",
    ),
  );
  const provider = new MarkdownMemoryProvider({ today: () => "2026-09-13" });

  expect((await provider.propose(proposalInput(repo))).action).toBe("no_change");
  expect(
    (await provider.propose({ ...proposalInput(repo), summary: "Retry every failed charge immediately." })).action,
  ).toBe("needs_resolution");
});

test("rejects secret-like content and absolute evidence paths before rendering", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider();

  await expect(
    provider.propose({ ...proposalInput(repo), summary: "token=abcdefghijklmnopqrstuvwxyz123456" }),
  ).rejects.toMatchObject({ code: "secret_rejected" } satisfies Partial<LocalBrainError>);
  await expect(
    provider.propose({ ...proposalInput(repo), evidence: [{ kind: "file", ref: "/private/key" }] }),
  ).rejects.toMatchObject({
    code: "proposal_invalid",
  } satisfies Partial<LocalBrainError>);
});

test("rejects transcript fields and unknown evidence kinds", async () => {
  const repo = fixtureRepo();
  writeMemory(repo, memory("Use local state."));
  const provider = new MarkdownMemoryProvider();

  await expect(
    provider.propose({ ...proposalInput(repo), transcript: "never accepted" } as never),
  ).rejects.toMatchObject({
    code: "proposal_invalid",
  } satisfies Partial<LocalBrainError>);
  await expect(
    provider.propose({ ...proposalInput(repo), evidence: [{ kind: "chat", ref: "session" }] as never }),
  ).rejects.toMatchObject({
    code: "proposal_invalid",
  } satisfies Partial<LocalBrainError>);
});
