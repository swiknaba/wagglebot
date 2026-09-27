import { expect, test } from "bun:test";
import type {
  LocalBrain,
  LocalBrainStatus,
  LocalMemoryHit,
  LocalMemoryProposal,
  LocalMemorySaveResult,
} from "@wagglebot/local-brain";
import { createLocalBrain, MarkdownMemoryProvider } from "@wagglebot/local-brain";
import { createLowLevelServer, TOOL_NAMES } from "./low-level";

const invalidConceptPaths = [
  "",
  "\u0000",
  "/.agents/memory/warnings/retry-writes.md",
  "C:/repo/.agents/memory/warnings/retry-writes.md",
  ".agents/memory\\warnings\\retry-writes.md",
  ".agents/memory//warnings/retry-writes.md",
  ".agents/memory/./warnings/retry-writes.md",
  ".agents/memory/../warnings/retry-writes.md",
  ".agents/memory/warnings/\u0000/retry-writes.md",
  ".agents/memory/.env/retry-writes.md",
  ".agents/memory/.ENV/retry-writes.md",
  ".agents/memory/warnings/.env.local/retry-writes.md",
  ".agents/memory/warnings/.ENV.local/retry-writes.md",
  ".agents/memory/certificates/server.pem/retry-writes.md",
  ".agents/memory/certificates/server.PEM/retry-writes.md",
  ".agents/memory/keys/service.key/retry-writes.md",
  ".agents/memory/keys/service.KEY/retry-writes.md",
  ".agents/memory/credentials/retry-writes.md",
  ".agents/memory/CREDENTIALS/retry-writes.md",
  ".agents/memory/secrets/retry-writes.md",
  ".agents/memory/warnings/SECRETS/retry-writes.md",
  "outside/warnings/retry-writes.md",
  ".agents/memory",
  ".agents/memory.md",
  ".agents/memory/index.md",
  ".agents/memory/warnings/index.md",
  ".agents/memory/log.md",
  ".agents/memory/warnings/log.md",
];

const hit: LocalMemoryHit = {
  id: "chunk-1",
  path: ".agents/memory/warnings/retry.md",
  type: "Warning",
  title: "Retry safely",
  description: "",
  tags: ["warning"],
  headingPath: ["Warning"],
  content: "Check the idempotency record.",
  startLine: 10,
  endLine: 10,
  contentHash: "a".repeat(64),
  score: 1.5,
};

const proposal: LocalMemoryProposal = {
  proposalId: "c".repeat(64),
  baseBundleHash: "a".repeat(64),
  path: ".agents/memory/warnings/retry.md",
  section: "Warnings",
  title: "Retry safely",
  summary: "Check the idempotency record.",
  evidence: [{ kind: "file", ref: "src/a.ts:1" }],
  action: "add",
  content: "---\ntype: Warning\n---\n\n# Warning\n",
  indexChanges: [{ path: ".agents/memory/index.md", content: "# Component Memory\n" }],
  patch: "+ entry",
  warnings: [],
};

const memoryWith = (overrides: Partial<LocalBrain["memory"]> = {}): LocalBrain["memory"] => {
  const provider = new MarkdownMemoryProvider();
  return {
    read: overrides.read ?? provider.read.bind(provider),
    search: overrides.search ?? provider.search.bind(provider),
    propose: overrides.propose ?? provider.propose.bind(provider),
    save: overrides.save ?? provider.save.bind(provider),
  };
};

type BrainOverrides = Omit<Partial<LocalBrain>, "memory"> & {
  memory?: Partial<LocalBrain["memory"]>;
};

const testBrain = (overrides: BrainOverrides = {}): LocalBrain => ({
  ...createLocalBrain(),
  ...overrides,
  memory: memoryWith(overrides.memory),
});

test("registers exactly the seven documented local tools", () => {
  const server = createLowLevelServer(testBrain());
  expect(TOOL_NAMES).toEqual([
    "local_memory_search",
    "brain_memory_propose",
    "brain_memory_save",
    "codegraph_explore",
    "git_history",
    "git_why",
    "local_brain_status",
  ]);
  expect(server).toBeDefined();
});

test("rejects a relative project path before provider access", async () => {
  let called = false;
  const git = createLocalBrain().git;
  if (!("history" in git)) throw new Error("default brain should include Git history");
  git.history = async () => {
    called = true;
    return { commits: [], limitations: [] };
  };
  const server = createLowLevelServer(testBrain({ git }));
  const result = await server.invoke("git_history", { projectPath: "../repo", path: "src/a.ts" });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("absolute projectPath");
  expect(called).toBe(false);
});

test("search returns one provider snapshot and never performs a second read", async () => {
  let reads = 0;
  const server = createLowLevelServer(
    testBrain({
      memory: {
        search: async () => ({ hits: [hit], bundleHash: "b".repeat(64) }),
        read: async () => {
          reads += 1;
          throw new Error("search must not read twice");
        },
      },
    }),
  );

  const response = await server.invoke("local_memory_search", { projectPath: "/repo", query: "retry" });

  expect(response.isError).toBeUndefined();
  expect(response.structuredContent).toMatchObject({
    schemaVersion: 1,
    hits: [hit],
    bundleHash: "b".repeat(64),
  });
  expect(reads).toBe(0);
});

test("search query length uses Unicode code points at the provider boundary", async () => {
  const queries: string[] = [];
  const server = createLowLevelServer(
    testBrain({
      memory: {
        search: async ({ query }) => {
          queries.push(query);
          return { hits: [], bundleHash: "b".repeat(64) };
        },
      },
    }),
  );
  const atLimit = "🪲".repeat(2_000);
  const overLimit = "🪲".repeat(2_001);

  const accepted = await server.invoke("local_memory_search", { projectPath: "/repo", query: atLimit });
  const rejected = await server.invoke("local_memory_search", { projectPath: "/repo", query: overLimit });

  expect(accepted.isError).toBeUndefined();
  expect(rejected.isError).toBe(true);
  expect(queries).toEqual([atLimit]);
});

test("proposal and save schemas validate the complete OKF proposal boundary", async () => {
  const proposed: unknown[] = [];
  let saves = 0;
  const saveResult: LocalMemorySaveResult = {
    path: proposal.path,
    action: "add",
    previousBundleHash: "a".repeat(64),
    newBundleHash: "b".repeat(64),
    patch: "+ entry",
    warnings: [],
  };
  const server = createLowLevelServer(
    testBrain({
      memory: {
        propose: async (input) => {
          proposed.push(input);
          return proposal;
        },
        save: async () => {
          saves += 1;
          return saveResult;
        },
      },
    }),
  );

  const replacement = { path: ".agents/memory/warnings/old.md", contentHash: "c".repeat(64) };
  const preview = await server.invoke("brain_memory_propose", {
    projectPath: "/repo",
    section: "Warnings",
    title: "Retry safely",
    summary: "Check the idempotency record.",
    evidence: [{ kind: "file", ref: "src/a.ts:1" }],
    replace: replacement,
  });
  expect(preview.isError).toBeUndefined();
  expect(proposed[0]).toMatchObject({ replace: replacement });

  const rootConceptReplacement = await server.invoke("brain_memory_propose", {
    projectPath: "/repo",
    section: "Warnings",
    title: "Retry safely",
    summary: "Check the idempotency record.",
    evidence: [{ kind: "file", ref: "src/a.ts:1" }],
    replace: { path: ".agents/memory/component.md", contentHash: "c".repeat(64) },
  });
  expect(rootConceptReplacement.isError).toBeUndefined();

  for (const invalid of [
    { ...proposal, path: ".agents/memory.md" },
    { ...proposal, path: ".agents/memory/warnings/index.md" },
    { ...proposal, path: ".agents/memory/../outside.md" },
    { ...proposal, baseBundleHash: "ABC" },
    { ...proposal, replace: { path: ".agents/memory/log.md", contentHash: "c".repeat(64) } },
    { ...proposal, replace: { path: ".agents/memory/warnings/old.md", contentHash: "bad" } },
    { ...proposal, extra: true },
  ]) {
    const result = await server.invoke("brain_memory_save", { projectPath: "/repo", proposal: invalid });
    expect(result.isError).toBe(true);
  }

  for (const path of invalidConceptPaths) {
    for (const invalid of [
      { ...proposal, path },
      { ...proposal, replace: { path, contentHash: "c".repeat(64) } },
    ]) {
      const result = await server.invoke("brain_memory_save", { projectPath: "/repo", proposal: invalid });
      expect(result.isError).toBe(true);
    }
    const invalidReplacement = await server.invoke("brain_memory_propose", {
      projectPath: "/repo",
      section: "Warnings",
      title: "Retry safely",
      summary: "Check the idempotency record.",
      evidence: [{ kind: "file", ref: "src/a.ts:1" }],
      replace: { path, contentHash: "c".repeat(64) },
    });
    expect(invalidReplacement.isError).toBe(true);
  }

  const saved = await server.invoke("brain_memory_save", { projectPath: "/repo", proposal });
  expect(saved.isError).toBeUndefined();
  expect(saves).toBe(1);
  expect(saved.structuredContent).toMatchObject({
    schemaVersion: 1,
    path: proposal.path,
    previousBundleHash: "a".repeat(64),
    newBundleHash: "b".repeat(64),
  });
});

test("local status forwards memory bundle metadata and preserves provider isolation", async () => {
  const expected: LocalBrainStatus = {
    project: { workingTree: "clean", catalogState: "resolved" },
    memory: { path: ".agents/memory", state: "invalid", observedAt: "now" },
    codeGraph: { state: "ready", pendingFiles: [], observedAt: "now" },
    git: { state: "error", shallow: false },
    observedAt: "now",
  };
  const server = createLowLevelServer(testBrain({ status: async () => expected }));
  const response = await server.invoke("local_brain_status", { projectPath: "/repo" });
  expect(response.structuredContent).toMatchObject({ schemaVersion: 1, status: expected });
});
