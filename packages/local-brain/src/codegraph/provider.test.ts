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

const fakeHandle = (): CodeGraphHandle & {
  unwatchCalls: number;
  closeCalls: number;
  syncCalls: number;
  watchCalls: number;
} => ({
  unwatchCalls: 0,
  closeCalls: 0,
  syncCalls: 0,
  watchCalls: 0,
  indexAll: async () => undefined,
  async sync() {
    this.syncCalls += 1;
  },
  buildContext: async () => context,
  watch() {
    this.watchCalls += 1;
    return true;
  },
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
  expect(result.nodes[0]?.snippet).toContain("export const entry");
});

test("maps SDK location-based code blocks to one matching graph node", async () => {
  const api = fakeApi();
  const originalOpen = api.open.bind(api);
  api.open = async (root, options) => {
    const handle = await originalOpen(root, options);
    handle.buildContext = async () => ({
      subgraph: {
        nodes: [{ id: "entry", kind: "function", name: "entry", filePath: "src/entry.ts", startLine: 1, endLine: 3 }],
        edges: [],
      },
      codeBlocks: [
        {
          filePath: "./src\\entry.ts",
          startLine: 1,
          endLine: 3,
          content: "export const entry = () => service();",
          nodeName: "entry",
          nodeKind: "function",
        },
      ],
    });
    return handle;
  };
  const repo = fixtureRepo();

  const result = await new CodeGraphProvider({ api }).explore({
    projectRoot: repo,
    query: "entry",
    maxNodes: 20,
    includeCode: true,
  });

  expect(result.nodes[0]?.snippet).toBe("export const entry = () => service();");
});

test("does not attach an SDK code block when multiple graph nodes match its location", async () => {
  const api = fakeApi();
  const originalOpen = api.open.bind(api);
  api.open = async (root, options) => {
    const handle = await originalOpen(root, options);
    handle.buildContext = async () => ({
      subgraph: {
        nodes: [
          { id: "entry", kind: "function", name: "entry", filePath: "src/entry.ts", startLine: 1, endLine: 3 },
          { id: "wrapper", kind: "function", name: "wrapper", filePath: "src/entry.ts", startLine: 1, endLine: 3 },
        ],
        edges: [],
      },
      codeBlocks: [
        {
          filePath: "src/entry.ts",
          startLine: 1,
          endLine: 3,
          content: "ambiguous code",
        },
      ],
    });
    return handle;
  };
  const repo = fixtureRepo();

  const result = await new CodeGraphProvider({ api }).explore({
    projectRoot: repo,
    query: "entry",
    maxNodes: 20,
    includeCode: true,
  });

  expect(result.nodes.every((node) => node.snippet === undefined)).toBe(true);
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

test("context retrieval opens without synchronization or a watcher", async () => {
  const api = fakeApi();
  const options: Array<{ synchronize?: boolean; watch?: boolean; signal?: AbortSignal } | undefined> = [];
  const originalOpen = api.open.bind(api);
  api.open = async (root, openOptions) => {
    options.push(openOptions);
    return originalOpen(root, openOptions);
  };
  const provider = new CodeGraphProvider({ api });
  const repo = fixtureRepo();

  const result = await provider.exploreContext({ projectRoot: repo, query: "entry", maxNodes: 10, includeCode: true });
  const handle = api.handles.get(api.openCalls[0] ?? "");
  expect(options[0]).toMatchObject({ synchronize: false, watch: false });
  expect(handle?.syncCalls).toBe(0);
  expect(handle?.watchCalls).toBe(0);
  expect(result.nodes[0]?.snippet).toContain("entry");
});
