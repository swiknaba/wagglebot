import { expect, test } from "bun:test";

import { createLowLevelServer, TOOL_NAMES } from "./low-level";

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

test("keeps proposals ephemeral and allows memory when CodeGraph fails", async () => {
  let writes = 0;
  const server = createLowLevelServer({
    memory: {
      propose: async () => ({
        proposalId: "p",
        baseContentHash: "base",
        section: "Warnings",
        title: "Retry rule",
        summary: "summary",
        evidence: [{ kind: "file", ref: "src/a.ts:1" }],
        action: "add",
        patch: "+ entry",
        warnings: [],
      }),
      search: async () => [
        {
          id: "warning",
          headingPath: ["Warnings"],
          content: "warning",
          startLine: 1,
          endLine: 1,
          contentHash: "hash",
          path: ".agents/memory.md",
          score: 1,
        },
      ],
      read: async () => ({ contentHash: "hash" }),
      save: async () => {
        writes += 1;
        throw new Error("save was not expected");
      },
    },
    code: {
      explore: async () => {
        throw new Error("unavailable");
      },
    },
  } as never);

  const proposal = await server.invoke("brain_memory_propose", {
    projectPath: "/repo",
    section: "Warnings",
    title: "Retry rule",
    summary: "summary",
    evidence: [{ kind: "file", ref: "src/a.ts:1" }],
  });
  expect(proposal.isError).toBeUndefined();
  expect(writes).toBe(0);
  expect((await server.invoke("codegraph_explore", { projectPath: "/repo", query: "flow" })).isError).toBe(true);
  expect(
    (await server.invoke("local_memory_search", { projectPath: "/repo", query: "warning" })).isError,
  ).toBeUndefined();
});

test("does not accept free-form fields in a memory save proposal", async () => {
  const server = createLowLevelServer({} as never);
  const result = await server.invoke("brain_memory_save", {
    projectPath: "/repo",
    proposal: {
      proposalId: "p",
      baseContentHash: "base",
      section: "Warnings",
      title: "Retry rule",
      summary: "summary",
      evidence: [{ kind: "file", ref: "src/a.ts:1" }],
      action: "add",
      patch: "+ entry",
      warnings: [],
      replacementText: "unsafe free-form content",
    },
  });
  expect(result.isError).toBe(true);
});
