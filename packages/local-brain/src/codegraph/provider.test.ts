import { expect, test } from "bun:test";
import { fixtureRepo } from "../memory/test-fixture";
import type { CodeGraphApi, CodeGraphHandle } from "./provider";
import { CodeGraphProvider } from "./provider";

const context = {
  subgraph: {
    nodes: [
      { id: "entry", kind: "function", name: "entry", filePath: "src/entry.ts", startLine: 1, endLine: 3 },
      { id: "service", kind: "function", name: "service", filePath: "src/service.ts", startLine: 1, endLine: 3 },
    ],
    edges: [{ source: "entry", target: "service", kind: "calls" }],
  },
  codeBlocks: [{ nodeId: "entry", code: "export const entry = () => service();" }],
};

const fakeHandle = (): CodeGraphHandle & { unwatchCalls: number; closeCalls: number } => ({
  unwatchCalls: 0,
  closeCalls: 0,
  indexAll: async () => undefined,
  sync: async () => undefined,
  buildContext: async () => context,
  watch: () => true,
  unwatch() {
    this.unwatchCalls += 1;
  },
  close() {
    this.closeCalls += 1;
  },
  getPendingFiles: () => [],
});

const fakeApi = (): CodeGraphApi & {
  initCalls: string[];
  openCalls: string[];
  handles: Map<string, ReturnType<typeof fakeHandle>>;
} => {
  const handles = new Map<string, ReturnType<typeof fakeHandle>>();
  return {
    initCalls: [],
    openCalls: [],
    handles,
    async init(root) {
      this.initCalls.push(root);
      const handle = fakeHandle();
      handles.set(root, handle);
      return handle;
    },
    async open(root) {
      this.openCalls.push(root);
      const handle = fakeHandle();
      handles.set(root, handle);
      return handle;
    },
  };
};

test("a normal query opens an existing index and never reinitializes it", async () => {
  const api = fakeApi();
  const provider = new CodeGraphProvider({ api, maxOpenProjects: 2 });
  const repo = fixtureRepo();

  const result = await provider.explore({ projectRoot: repo, query: "entry", maxNodes: 20, includeCode: true });

  expect(api.openCalls).toHaveLength(1);
  expect(api.initCalls).toEqual([]);
  expect(result.nodes).toHaveLength(2);
  expect(result.edges).toEqual([{ from: "entry", to: "service", kind: "calls" }]);
});

test("initialize builds once, watches, and LRU eviction closes the oldest project", async () => {
  const api = fakeApi();
  const provider = new CodeGraphProvider({ api, maxOpenProjects: 1 });
  const repoA = fixtureRepo();
  const repoB = fixtureRepo();

  await provider.initialize(repoA);
  await provider.explore({ projectRoot: repoB, query: "entry", maxNodes: 20, includeCode: false });

  expect(api.initCalls).toHaveLength(1);
  expect(api.handles.get(api.initCalls[0] ?? "")?.unwatchCalls).toBe(1);
  expect(api.handles.get(api.initCalls[0] ?? "")?.closeCalls).toBe(1);
});

test("pending files mark results stale without exposing an absolute path", async () => {
  const api = fakeApi();
  const provider = new CodeGraphProvider({ api });
  const repo = fixtureRepo();
  const originalOpen = api.open.bind(api);
  api.open = async (root) => {
    const handle = await originalOpen(root);
    handle.getPendingFiles = () => [{ path: "src/service.ts" }];
    return handle;
  };

  const result = await provider.explore({ projectRoot: repo, query: "entry", maxNodes: 20, includeCode: true });

  expect(result.state).toBe("stale");
  expect(result.pendingFiles).toEqual(["src/service.ts"]);
  expect(JSON.stringify(result)).not.toContain(repo);
});
