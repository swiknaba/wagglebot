import { expect, test } from "bun:test";
import type { LocalBrain } from "@wagglebot/local-brain";
import { createContextEngine } from "./engine";

const identity = {
  component: "billing",
  system: "payments",
  domain: "finance",
  owner: "team",
  branch: "main",
  head: "a".repeat(40),
  workingTree: "clean" as const,
  catalogState: "resolved" as const,
};
const hit = {
  id: "chunk-a",
  path: ".agents/memory/warnings/retries.md" as const,
  type: "Warning",
  title: "Retry safely",
  description: "",
  tags: ["retry"],
  headingPath: ["Warning"],
  content: "Check the operation key before retrying.",
  startLine: 2,
  endLine: 3,
  contentHash: "b".repeat(64),
  score: 1,
};

const brain = (): LocalBrain => ({
  identify: async () => identity,
  memory: {
    read: async () => undefined,
    search: async () => ({ hits: [hit], bundleHash: "c".repeat(64) }),
    propose: async () => {
      throw new Error("unused");
    },
    save: async () => {
      throw new Error("unused");
    },
  },
  code: {
    status: async () => ({ state: "missing", pendingFiles: [], observedAt: new Date().toISOString() }),
    close: async () => {},
    exploreContext: async () => ({
      query: "retry",
      state: "ready",
      nodes: [],
      edges: [],
      pendingFiles: [],
      observedAt: new Date().toISOString(),
      limitations: [],
    }),
  } as unknown as LocalBrain["code"],
  git: {
    status: async () => ({ state: "ready", head: identity.head, branch: "main", workingTree: "clean", shallow: false }),
    history: async () => ({ commits: [], limitations: [] }),
  } as unknown as LocalBrain["git"],
  status: async () => ({
    project: identity,
    memory: { path: ".agents/memory", state: "ready", observedAt: new Date().toISOString() },
    codeGraph: { state: "ready", pendingFiles: [], observedAt: new Date().toISOString() },
    git: { state: "ready", shallow: false },
    observedAt: new Date().toISOString(),
  }),
  close: async () => {},
});

test("automatic L0 is local-only and returns identity without retrieved items", async () => {
  let searches = 0;
  const local = brain();
  local.memory.search = async () => {
    searches += 1;
    return { hits: [] };
  };
  const engine = createContextEngine(local);
  const result = await engine.wake({ projectPath: "/repo" });
  expect(result.mode).toBe("wake");
  expect(result.items).toEqual([]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(150);
  expect(searches).toBe(0);
});

test("search returns evidence and cursor suppresses only facts already delivered", async () => {
  const engine = createContextEngine(brain());
  const first = await engine.search({ projectPath: "/repo", query: "retry safely" });
  expect(first.items[0]?.provenance[0]?.kind).toBe("local_memory");
  expect(first.degraded.some(({ provider }) => provider === "shared_memory")).toBe(true);
  const next = await engine.search({ projectPath: "/repo", query: "retry safely", cursor: first.cursor });
  expect(next.items).toHaveLength(0);
  expect(next.omitted.reasons).toContain("already_delivered");
});

test("a changed code snippet is returned again with the previous cursor", async () => {
  const local = brain();
  let snippet = "return retryOnce();";
  local.memory.search = async () => ({ hits: [] });
  const code = local.code as unknown as { exploreContext: () => Promise<unknown> };
  code.exploreContext = async () => ({
    query: "retry",
    state: "ready",
    nodes: [
      {
        id: "stable-node",
        kind: "function",
        name: "retry",
        path: "src/worker.ts",
        startLine: 4,
        endLine: 6,
        snippet,
        stale: false,
      },
    ],
    edges: [],
    pendingFiles: [],
    observedAt: new Date().toISOString(),
    limitations: [],
  });
  const engine = createContextEngine(local);
  const first = await engine.search({ projectPath: "/repo", query: "retry", sources: ["code"] });
  expect(first.items[0]?.excerpt).toBe("return retryOnce();");
  snippet = "return retryWithBackoff();";
  const changed = await engine.search({
    projectPath: "/repo",
    query: "retry",
    sources: ["code"],
    cursor: first.cursor,
  });
  expect(changed.items[0]?.excerpt).toBe("return retryWithBackoff();");
});

test("L1 reports the CodeGraph missing state returned by status", async () => {
  const result = await createContextEngine(brain()).wake({ projectPath: "/repo", level: 1 });
  expect(result.freshness.codeGraph).toBe("missing");
});

test("CodeGraph pending files survive cursor suppression", async () => {
  const local = brain();
  local.memory.search = async () => ({ hits: [] });
  const code = local.code as unknown as { exploreContext: () => Promise<unknown> };
  code.exploreContext = async () => ({
    query: "retry",
    state: "pending",
    nodes: [
      {
        id: "stable-node",
        kind: "function",
        name: "retry",
        path: "src/worker.ts",
        startLine: 4,
        endLine: 6,
        snippet: "return retryOnce();",
        stale: true,
      },
    ],
    edges: [],
    pendingFiles: ["src/worker.ts"],
    observedAt: new Date().toISOString(),
    limitations: [],
  });
  const engine = createContextEngine(local);
  const first = await engine.search({ projectPath: "/repo", query: "retry", sources: ["code"] });
  expect(first.freshness.codeGraph).toBe("pending");
  expect(first.freshness.pendingFiles).toEqual(["src/worker.ts"]);
  const next = await engine.search({
    projectPath: "/repo",
    query: "retry",
    sources: ["code"],
    cursor: first.cursor,
  });
  expect(next.items).toEqual([]);
  expect(next.freshness.codeGraph).toBe("pending");
  expect(next.freshness.pendingFiles).toEqual(["src/worker.ts"]);
});

test("warnings are retained ahead of optional exact matches when the budget is tight", async () => {
  const local = brain();
  local.memory.search = async () => ({
    hits: [
      {
        ...hit,
        id: "fact",
        path: ".agents/memory/facts/retry.md",
        type: "Fact",
        title: "Implementation detail",
        content: "Optional charge implementation detail. ".repeat(30),
        score: 2,
      },
      {
        ...hit,
        id: "warning",
        title: "Do not retry blindly",
        content: "Charges can be duplicated when a retry is blind.",
        score: 1,
      },
    ],
  });
  const result = await createContextEngine(local).search({
    projectPath: "/repo",
    query: "charges",
    sources: ["local_memory"],
    maxTokens: 350,
  });
  expect(result.items.map(({ id, kind }) => [id, kind])).toEqual([["local:warning", "Warning"]]);
  expect(result.omitted).toMatchObject({ candidates: 1, reasons: ["budget"] });
});

test("a warning that cannot fit its budget fails instead of disappearing", async () => {
  const local = brain();
  local.memory.search = async () => ({
    hits: [{ ...hit, title: "Do not retry blindly", content: "Charges can be duplicated. ".repeat(40), score: 1 }],
  });
  await expect(
    createContextEngine(local).search({
      projectPath: "/repo",
      query: "charges",
      sources: ["local_memory"],
      maxTokens: 200,
    }),
  ).rejects.toMatchObject({ code: "context_invalid" });
});

test("L2 requires a task before reaching providers", async () => {
  const engine = createContextEngine(brain());
  await expect(engine.wake({ projectPath: "/repo", level: 2 })).rejects.toThrow();
});

test("L1 uses shared wake while task-specific L2 and L3 query shared memory", async () => {
  const requests: Array<{
    schemaVersion: number;
    purpose: string;
    query?: string;
    cascade: object;
    limit: number;
  }> = [];
  const shared = {
    search: async (input: unknown) => {
      requests.push(input as (typeof requests)[number]);
      return { schemaVersion: 1 as const, records: [] };
    },
    wake: async (input: unknown) => {
      requests.push(input as (typeof requests)[number]);
      return { schemaVersion: 1 as const, records: [] };
    },
    status: async () => ({ state: "ready" as const, observedAt: new Date().toISOString() }),
  } as unknown as NonNullable<Parameters<typeof createContextEngine>[1]>["shared"];
  const engine = createContextEngine(brain(), { shared });
  await engine.wake({ projectPath: "/repo", level: 1, task: "continue" });
  await engine.wake({ projectPath: "/repo", level: 2, task: "review billing retries" });
  await engine.wake({ projectPath: "/repo", level: 3, task: "review billing retries deeply" });
  expect(requests).toEqual([
    { schemaVersion: 1, purpose: "wake", cascade: expect.any(Object), limit: 3 },
    {
      schemaVersion: 1,
      purpose: "query",
      query: "review billing retries",
      cascade: expect.any(Object),
      limit: 6,
    },
    {
      schemaVersion: 1,
      purpose: "query",
      query: "review billing retries deeply",
      cascade: expect.any(Object),
      limit: 6,
    },
  ]);
});

test("shared requests are frozen before retrieval and contain only the original search query and catalog scopes", async () => {
  let received: unknown;
  let identities = 0;
  const local = brain();
  local.identify = async () => {
    identities += 1;
    return identity;
  };
  const shared = {
    search: async (input: unknown) => {
      received = input;
      return { schemaVersion: 1 as const, records: [] };
    },
    wake: async (input: unknown) => {
      received = input;
      return { schemaVersion: 1 as const, records: [] };
    },
    status: async () => ({ state: "ready" as const, observedAt: new Date().toISOString() }),
  } as unknown as NonNullable<Parameters<typeof createContextEngine>[1]>["shared"];
  const engine = createContextEngine(local, { shared });
  await engine.search({ projectPath: "/repo", query: "how are retries bounded?" });
  expect(received).toEqual({
    schemaVersion: 1,
    purpose: "query",
    query: "how are retries bounded?",
    cascade: { component: "billing", system: "payments", domain: "finance", includeOrg: true },
    limit: 6,
  });
  expect(Object.isFrozen(received)).toBe(true);
  expect(Object.isFrozen((received as { cascade: object }).cascade)).toBe(true);
  expect(identities).toBe(2); // one identity snapshot before retrieval and one checkout freshness check after it
});

test("explain does not send a symbol or path to shared memory without natural-language query", async () => {
  let sharedCalls = 0;
  const shared = {
    search: async () => {
      sharedCalls += 1;
      return { schemaVersion: 1 as const, records: [] };
    },
    wake: async () => {
      sharedCalls += 1;
      return { schemaVersion: 1 as const, records: [] };
    },
    status: async () => ({ state: "ready" as const, observedAt: new Date().toISOString() }),
  } as unknown as NonNullable<Parameters<typeof createContextEngine>[1]>["shared"];
  await createContextEngine(brain(), { shared }).explain({
    projectPath: "/repo",
    symbol: "TokenService.rotate",
    path: "src/token.ts",
  });
  expect(sharedCalls).toBe(0);
});
