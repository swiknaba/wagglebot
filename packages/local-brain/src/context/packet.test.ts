import { expect, test } from "bun:test";
import { ContextBridgeExportInputSchema } from "@wagglebot/contracts";
import { ContextBridgeError, createBridgePacket } from "./packet";

const project = { workingTree: "clean" as const, catalogState: "resolved" as const };
const input = ContextBridgeExportInputSchema.parse({
  projectPath: "/repo",
  goal: "Ship context bridge",
  decisions: [],
  openQuestions: [],
  evidence: [],
  providerState: { localBrain: "ready", sharedMemory: "not_requested" },
});

test("packet builder binds canonical project metadata and uses the selected TTL", () => {
  const packet = createBridgePacket(input, project, `rk_${"a".repeat(32)}`, new Date("2026-10-25T10:00:00Z"));
  expect(packet.project.rootKey).toBe(`rk_${"a".repeat(32)}`);
  expect(Date.parse(packet.expiresAt) - Date.parse(packet.createdAt)).toBe(3_600_000);
});

test("packet scanner rejects secrets, absolute paths, and transcript-shaped content", () => {
  for (const goal of [
    "token=AKIA1234567890ABCDEF",
    "Read /Users/person/project",
    "Read\n/Users/private/project",
    "unsafe\u0000goal",
    "User: continue from here",
  ]) {
    expect(() => createBridgePacket({ ...input, goal }, project, `rk_${"a".repeat(32)}`, new Date())).toThrow(
      ContextBridgeError,
    );
  }
});

test("packet scanner preserves ordinary multiline prose", () => {
  expect(() =>
    createBridgePacket(
      { ...input, goal: "Review the safe option.\nContinue after tests." },
      project,
      `rk_${"a".repeat(32)}`,
      new Date(),
    ),
  ).not.toThrow();
});
