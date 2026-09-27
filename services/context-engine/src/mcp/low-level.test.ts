import { expect, test } from "bun:test";

import { createLowLevelServer, TOOL_NAMES } from "./low-level";

const hit = {
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

const proposal = {
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

test("registers exactly the seven documented local tools", () => {
  const server = createLowLevelServer({} as never);
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
  const server = createLowLevelServer({
    git: {
      history: async () => {
        called = true;
        return { commits: [], limitations: [] };
      },
    },
  } as never);
  const result = await server.invoke("git_history", { projectPath: "../repo", path: "src/a.ts" });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("absolute projectPath");
  expect(called).toBe(false);
});

test("search returns one provider snapshot and never performs a second read", async () => {
  let reads = 0;
  const server = createLowLevelServer({
    memory: {
      search: async () => ({ hits: [hit], bundleHash: "b".repeat(64) }),
      read: async () => {
        reads += 1;
        throw new Error("search must not read twice");
      },
    },
  } as never);

  const response = await server.invoke("local_memory_search", { projectPath: "/repo", query: "retry" });

  expect(response.isError).toBeUndefined();
  expect(response.structuredContent).toMatchObject({
    schemaVersion: 1,
    hits: [hit],
    bundleHash: "b".repeat(64),
  });
  expect(reads).toBe(0);
});

test("proposal and save schemas validate the complete OKF proposal boundary", async () => {
  const proposed: unknown[] = [];
  let saves = 0;
  const server = createLowLevelServer({
    memory: {
      propose: async (input: unknown) => {
        proposed.push(input);
        return proposal;
      },
      save: async () => {
        saves += 1;
        return {
          path: proposal.path,
          action: "add",
          previousBundleHash: "a".repeat(64),
          newBundleHash: "b".repeat(64),
          patch: "+ entry",
          warnings: [],
        };
      },
    },
  } as never);

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
  const expected = {
    project: { workingTree: "clean", catalogState: "resolved" },
    memory: { path: ".agents/memory", state: "invalid", observedAt: "now" },
    codeGraph: { state: "ready", pendingFiles: [], observedAt: "now" },
    git: { state: "error", shallow: false },
    observedAt: "now",
  };
  const server = createLowLevelServer({ status: async () => expected } as never);
  const response = await server.invoke("local_brain_status", { projectPath: "/repo" });
  expect(response.structuredContent).toMatchObject({ schemaVersion: 1, status: expected });
});
