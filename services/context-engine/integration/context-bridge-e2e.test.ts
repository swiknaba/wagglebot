import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalBrain } from "@wagglebot/local-brain";
import { ContextVault, createContextBridge } from "@wagglebot/local-brain";

const identity = {
  component: "payments",
  system: "billing",
  workingTree: "clean" as const,
  catalogState: "resolved" as const,
};

test("Context Bridge is explicit, scoped, expiring, and restart-safe", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wagglebot-context-bridge-e2e-"));
  const firstRepo = join(parent, "first");
  const secondRepo = join(parent, "second");
  const vaultDirectory = join(parent, "vault");
  await Promise.all([mkdir(firstRepo), mkdir(secondRepo)]);
  for (const repo of [firstRepo, secondRepo]) execFileSync("git", ["init", "-q", repo]);
  let now = new Date("2026-10-25T10:00:00.000Z");
  const brain = { identify: async () => identity } as unknown as Pick<LocalBrain, "identify">;
  const makeBridge = () =>
    createContextBridge(brain, {
      now: () => new Date(now),
      vault: new ContextVault({ directory: vaultDirectory, now: () => new Date(now) }),
    });

  try {
    const first = makeBridge();
    await first.initialize();
    const exported = await first.export({
      projectPath: firstRepo,
      goal: "Finish the reviewed migration",
      decisions: [{ title: "Keep rollback atomic", summary: "Replace only the two application tables." }],
      openQuestions: ["Which service owns the readiness gate?"],
      evidence: [],
      providerState: { localBrain: "ready", sharedMemory: "not_requested" },
      ttlSeconds: 60,
    });
    const handle = exported.handle;
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const restarted = makeBridge();
    await restarted.initialize();
    const imported = await restarted.import({ handle, projectPath: firstRepo });
    expect(imported.importedContext.goal).toBe("Finish the reviewed migration");
    await expect(restarted.import({ handle, projectPath: secondRepo })).rejects.toMatchObject({
      code: "context_project_mismatch",
    });
    const status = await restarted.status({ projectPath: firstRepo });
    expect(status.packetCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("Finish the reviewed migration");
    expect(JSON.stringify(status)).not.toContain(handle);

    const workstation = await restarted.export({
      projectPath: firstRepo,
      scope: "workstation",
      goal: "Continue across repositories",
      decisions: [],
      openQuestions: [],
      evidence: [],
      providerState: { localBrain: "ready", sharedMemory: "not_requested" },
    });
    expect(
      (await restarted.import({ handle: workstation.handle, projectPath: secondRepo })).importedContext.scope,
    ).toBe("workstation");

    now = new Date("2026-10-25T10:02:00.000Z");
    await expect(restarted.import({ handle, projectPath: firstRepo })).rejects.toMatchObject({
      code: "context_expired",
    });
    await restarted.revoke({ handle: workstation.handle, projectPath: firstRepo });
    await restarted.revoke({ handle: workstation.handle, projectPath: firstRepo });
    expect(await readdir(vaultDirectory)).toHaveLength(0);

    await expect(
      restarted.export({
        projectPath: firstRepo,
        goal: "token=AKIA1234567890ABCDEF",
        decisions: [],
        openQuestions: [],
        evidence: [],
        providerState: { localBrain: "ready", sharedMemory: "not_requested" },
      }),
    ).rejects.toMatchObject({ code: "context_invalid" });
    expect(await readdir(vaultDirectory)).toHaveLength(0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
