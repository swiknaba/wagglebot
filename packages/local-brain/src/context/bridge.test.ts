import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextBridgeExportInputSchema } from "@wagglebot/contracts";
import type { LocalBrain } from "../local-brain";
import { fixtureRepo } from "../memory/test-fixture";
import { createContextBridge } from "./bridge";
import { ContextVault } from "./vault";

const identity = {
  component: "billing",
  system: "payments",
  branch: "main",
  head: "a".repeat(40),
  workingTree: "clean" as const,
  catalogState: "resolved" as const,
};
const brain = { identify: async () => identity } as Pick<LocalBrain, "identify">;
const input = (projectPath: string) =>
  ContextBridgeExportInputSchema.parse({
    projectPath,
    scope: "project",
    goal: "Finish provider integration",
    decisions: [{ title: "Keep it local", summary: "Bridge packets do not leave the workstation." }],
    openQuestions: ["Which source owns this rule?"],
    evidence: [{ kind: "code", path: "src/engine.ts", startLine: 10, endLine: 15, graphState: "ready" }],
    providerState: { localBrain: "ready", sharedMemory: "not_requested" },
  });

test("bridge exports, imports after restart, and status reveals metadata without handles or prose", async () => {
  const state = await mkdtemp(join(tmpdir(), "wagglebot-bridge-state-"));
  const repo = fixtureRepo();
  const now = () => new Date("2026-10-25T10:00:00Z");
  const bridge = createContextBridge(brain, {
    vault: new ContextVault({ directory: join(state, "context"), now }),
    now,
  });
  await bridge.initialize();
  const exported = await bridge.export(input(repo));
  const reopened = createContextBridge(brain, {
    vault: new ContextVault({ directory: join(state, "context"), now }),
    now,
  });
  const imported = await reopened.import({ handle: exported.handle, projectPath: repo });
  expect(imported.importedContext.goal).toBe("Finish provider integration");
  const status = await reopened.status({ projectPath: repo });
  expect(status.packetCount).toBe(1);
  expect(JSON.stringify(status)).not.toContain(exported.handle);
  expect(JSON.stringify(status)).not.toContain("Finish provider integration");
  expect(JSON.stringify(status)).not.toContain(repo);
});

test("bridge does not allow cross-project import unless export selected workstation scope", async () => {
  const state = await mkdtemp(join(tmpdir(), "wagglebot-bridge-scope-"));
  const firstRepo = fixtureRepo();
  const secondRepo = fixtureRepo();
  const bridge = createContextBridge(brain, { vault: new ContextVault({ directory: join(state, "context") }) });
  const first = await bridge.export(input(firstRepo));
  await expect(bridge.import({ handle: first.handle, projectPath: secondRepo })).rejects.toMatchObject({
    code: "context_project_mismatch",
  });
  const workstation = await bridge.export({ ...input(firstRepo), scope: "workstation" });
  expect((await bridge.import({ handle: workstation.handle, projectPath: secondRepo })).importedContext.scope).toBe(
    "workstation",
  );
});
