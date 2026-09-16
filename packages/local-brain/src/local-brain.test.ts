import { expect, test } from "bun:test";

import { createLocalBrain } from "./local-brain";

test("status retains healthy providers when CodeGraph fails", async () => {
  const brain = createLocalBrain({
    identity: async () => ({
      workingTree: "clean" as const,
      catalogState: "missing" as const,
      catalogWarning: "missing",
    }),
    memory: { read: async () => ({ contentHash: "hash" }) },
    code: {
      status: async () => {
        throw new Error("unavailable");
      },
      close: async () => undefined,
    },
    git: { status: async () => ({ state: "ready", shallow: false }) },
  });

  const status = await brain.status("/repo");

  expect(status.memory.state).toBe("ready");
  expect(status.codeGraph.state).toBe("error");
  expect(status.git.state).toBe("ready");
});

test("close releases CodeGraph only once", async () => {
  let closes = 0;
  const brain = createLocalBrain({
    identity: async () => ({ workingTree: "clean" as const, catalogState: "missing" as const }),
    memory: { read: async () => undefined },
    code: {
      status: async () => ({ state: "missing", pendingFiles: [], observedAt: "now" }),
      close: async () => {
        closes += 1;
      },
    },
    git: { status: async () => ({ state: "ready", shallow: false }) },
  });

  await brain.close();
  await brain.close();
  expect(closes).toBe(1);
});
