import { expect, test } from "bun:test";
import type { LocalBrain } from "./local-brain";
import { createLocalBrain } from "./local-brain";
import { LocalBrainError } from "./path-policy";
import type { LocalMemoryBundle } from "./types";

const requireCompleteMemoryApi = (memory: LocalBrain["memory"]): void => {
  void memory.read("/repo");
  void memory.search({ projectRoot: "/repo", query: "retry", limit: 1 });
  void memory.propose({
    projectRoot: "/repo",
    section: "Warnings",
    title: "Retry safely",
    summary: "Check the idempotency record.",
    evidence: [{ kind: "file", ref: "src/a.ts" }],
  });
  void memory.save({
    projectRoot: "/repo",
    proposal: {
      proposalId: "c".repeat(64),
      baseBundleHash: "a".repeat(64),
      path: ".agents/memory/warnings/retry.md",
      section: "Warnings",
      title: "Retry safely",
      summary: "Check the idempotency record.",
      evidence: [{ kind: "file", ref: "src/a.ts" }],
      action: "add",
      content: "# Warning\n",
      indexChanges: [],
      patch: "",
      warnings: [],
    },
  });
};

void requireCompleteMemoryApi;

const bundle = (overrides: Partial<LocalMemoryBundle> = {}): LocalMemoryBundle => ({
  path: ".agents/memory",
  concepts: [{}, {}] as LocalMemoryBundle["concepts"],
  indexes: [],
  logs: [],
  bundleHash: "a".repeat(64),
  totalBytes: 512,
  indexState: "stale",
  ...overrides,
});

const memoryProvider = (read: LocalBrain["memory"]["read"]): LocalBrain["memory"] => ({
  read,
  search: async () => ({ hits: [] }),
  propose: async () => {
    throw new Error("proposal is not used by status tests");
  },
  save: async () => {
    throw new Error("save is not used by status tests");
  },
});

const baseProviders = (memory: LocalBrain["memory"]) =>
  createLocalBrain({
    identity: async () => ({ workingTree: "clean" as const, catalogState: "missing" as const }),
    memory,
    code: {
      status: async () => ({ state: "ready" as const, pendingFiles: [], observedAt: "code-time" }),
      close: async () => undefined,
    },
    git: { status: async () => ({ state: "ready" as const, branch: "main", shallow: false }) },
  });

test("status carries bundle metadata and isolates independent CodeGraph and Git failures", async () => {
  const brain = createLocalBrain({
    identity: async () => ({ workingTree: "clean" as const, catalogState: "missing" as const }),
    memory: memoryProvider(async () => bundle()),
    code: {
      status: async () => {
        throw new Error("code unavailable");
      },
      close: async () => undefined,
    },
    git: { status: async () => ({ state: "ready" as const, branch: "main", shallow: false }) },
  });

  const status = await brain.status("/repo");

  expect(status.memory).toMatchObject({
    path: ".agents/memory",
    state: "ready",
    bundleHash: "a".repeat(64),
    conceptCount: 2,
    totalBytes: 512,
    indexState: "stale",
  });
  expect(status.memory.observedAt).toBe(status.observedAt);
  expect(status.codeGraph.state).toBe("error");
  expect(status.git.state).toBe("ready");
});

test("status maps missing, invalid, oversize, outside-path, and unexpected memory failures", async () => {
  expect((await baseProviders(memoryProvider(async () => undefined)).status("/repo")).memory).toMatchObject({
    path: ".agents/memory",
    state: "missing",
  });
  for (const code of ["local_memory_invalid", "local_memory_too_large", "path_outside_repository"] as const) {
    const status = await baseProviders(
      memoryProvider(async () => {
        throw new LocalBrainError(code, "memory unavailable");
      }),
    ).status("/repo");
    expect(status.memory.state).toBe("invalid");
    expect(status.codeGraph.state).toBe("ready");
    expect(status.git.state).toBe("ready");
  }
  const unexpected = await baseProviders(
    memoryProvider(async () => {
      throw new Error("unexpected I/O");
    }),
  ).status("/repo");
  expect(unexpected.memory.state).toBe("error");
  expect(unexpected.codeGraph.state).toBe("ready");
  expect(unexpected.git.state).toBe("ready");
});

test("close releases CodeGraph only once", async () => {
  let closes = 0;
  const brain = createLocalBrain({
    identity: async () => ({ workingTree: "clean" as const, catalogState: "missing" as const }),
    memory: memoryProvider(async () => undefined),
    code: {
      status: async () => ({ state: "missing" as const, pendingFiles: [], observedAt: "now" }),
      close: async () => {
        closes += 1;
      },
    },
    git: { status: async () => ({ state: "ready" as const, shallow: false }) },
  });

  await brain.close();
  await brain.close();
  expect(closes).toBe(1);
});
