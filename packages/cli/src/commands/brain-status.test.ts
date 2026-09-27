import { expect, test } from "bun:test";

import { runBrainStatus } from "./brain-status";

const status = {
  project: { workingTree: "clean" as const, catalogState: "missing" as const },
  memory: {
    path: ".agents/memory" as const,
    state: "ready" as const,
    bundleHash: "a".repeat(64),
    conceptCount: 2,
    totalBytes: 512,
    indexState: "stale" as const,
    observedAt: "now",
  },
  codeGraph: { state: "missing" as const, pendingFiles: [], observedAt: "now" },
  git: {
    state: "ready" as const,
    head: "1234567890abcdef",
    branch: "main",
    workingTree: "clean" as const,
    shallow: false,
  },
  observedAt: "now",
};

test("brain status typed JSON carries the bundle path, state, and metadata", async () => {
  const lines: string[] = [];
  const code = await runBrainStatus({
    projectPath: "/private/repo",
    json: true,
    write: (line) => lines.push(line),
    brain: { status: async () => status },
  });
  const response = JSON.parse(lines[0] ?? "{}") as { status: typeof status };
  expect(code).toBe(0);
  expect(response.status.memory).toEqual(status.memory);
  expect(lines.join("\n")).toContain('"schemaVersion":1');
  expect(lines.join("\n")).not.toContain("/private/repo");
});

test("brain status text reports path, concept count, bundle hash, and index state", async () => {
  const lines: string[] = [];
  await runBrainStatus({
    projectPath: "/repo",
    json: false,
    write: (line) => lines.push(line),
    brain: { status: async () => status },
  });
  const text = lines.join("\n");
  expect(text).toContain(".agents/memory");
  expect(text).toContain("2 concepts");
  expect(text).toContain("a".repeat(64));
  expect(text).toContain("stale");
});
