import { expect, test } from "bun:test";

import { runBrainStatus } from "./brain-status";

test("brain status emits typed JSON without an absolute root", async () => {
  const lines: string[] = [];
  const code = await runBrainStatus({
    projectPath: "/private/repo",
    json: true,
    write: (line) => lines.push(line),
    brain: {
      status: async () => ({
        project: { workingTree: "clean", catalogState: "missing" },
        memory: { state: "ready", contentHash: "abc", observedAt: "now" },
        codeGraph: { state: "missing", pendingFiles: [], observedAt: "now" },
        git: { state: "ready", head: "1234567890abcdef", branch: "main", workingTree: "clean", shallow: false },
        observedAt: "now",
      }),
    },
  });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain('"schemaVersion":1');
  expect(lines.join("\n")).not.toContain("/private/repo");
});
