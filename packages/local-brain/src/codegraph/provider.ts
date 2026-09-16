import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { LocalBrainError, resolveProjectPath } from "../path-policy";
import type { CodeGraphResult, CodeGraphStatus } from "../types";

type UpstreamNode = {
  id: string;
  kind: string;
  name: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
};

type UpstreamContext =
  | string
  | {
      subgraph: { nodes: UpstreamNode[]; edges: Array<{ source: string; target: string; kind: string }> };
      codeBlocks?: Array<{ nodeId: string; code: string }>;
    };

export type CodeGraphHandle = {
  indexAll(): Promise<unknown>;
  sync(): Promise<unknown>;
  buildContext(
    query: string,
    options: { maxNodes: number; includeCode: boolean; format: "json" },
  ): Promise<UpstreamContext>;
  watch(): boolean;
  unwatch(): void;
  close(): void;
  getPendingFiles?(): Array<{ path: string }>;
  waitUntilWatcherReady?(timeoutMs?: number): Promise<void>;
};

export type CodeGraphApi = {
  init(root: string): Promise<CodeGraphHandle>;
  open(root: string): Promise<CodeGraphHandle>;
};

export type CodeGraphProviderOptions = {
  api?: CodeGraphApi;
  load?: () => Promise<CodeGraphApi>;
  maxOpenProjects?: number;
  now?: () => string;
};

type OpenProject = { handle: CodeGraphHandle; observedAt: string };

const codePoints = (value: string): number => [...value].length;

const defaultLoader = async (): Promise<CodeGraphApi> => {
  process.env.CODEGRAPH_TELEMETRY ??= "0";
  const packageName = "@colbymchenry/codegraph";
  const module = (await import(packageName)) as { default?: CodeGraphApi };
  const api = module.default;
  if (api === undefined) throw new LocalBrainError("codegraph_unavailable", "CodeGraph SDK is unavailable");
  return api;
};

const safePath = (path: string | undefined): string | undefined =>
  path === undefined || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes("..")
    ? undefined
    : path;

const pendingPaths = (handle: CodeGraphHandle): string[] =>
  (handle.getPendingFiles?.() ?? [])
    .map((entry) => safePath(entry.path))
    .filter((path): path is string => path !== undefined);

const parseJsonContext = (context: UpstreamContext): UpstreamContext => {
  if (typeof context !== "string") return context;
  try {
    const parsed = JSON.parse(context) as {
      nodes?: UpstreamNode[];
      edges?: Array<{ source: string; target: string; kind: string }>;
      codeBlocks?: Array<{ nodeId: string; code: string }>;
    };
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return { subgraph: { nodes: parsed.nodes, edges: parsed.edges }, codeBlocks: parsed.codeBlocks };
    }
  } catch {
    // Non-JSON upstream results remain an opaque, bounded evidence snippet.
  }
  return context;
};

const observedStatus = (
  state: CodeGraphStatus["state"],
  pendingFiles: string[],
  observedAt: string,
): CodeGraphStatus => ({
  state,
  pendingFiles,
  observedAt,
});

export class CodeGraphProvider {
  readonly #projects = new Map<string, OpenProject>();
  readonly #maxOpenProjects: number;
  readonly #now: () => string;
  #api?: CodeGraphApi;
  readonly #load: () => Promise<CodeGraphApi>;

  constructor(options: CodeGraphProviderOptions = {}) {
    this.#api = options.api;
    this.#load = options.load ?? defaultLoader;
    this.#maxOpenProjects = options.maxOpenProjects ?? 8;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(projectPath: string): Promise<CodeGraphStatus> {
    const project = await resolveProjectPath(projectPath);
    const existing = this.#projects.get(project.root);
    if (existing !== undefined) return this.status(project.root);

    let handle: CodeGraphHandle;
    try {
      handle = await (await this.#getApi()).init(project.root);
      await handle.indexAll();
      handle.watch();
      await handle.waitUntilWatcherReady?.();
    } catch {
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph initialization failed");
    }
    this.#remember(project.root, handle);
    return observedStatus("ready", pendingPaths(handle), this.#now());
  }

  async explore(input: {
    projectRoot: string;
    query: string;
    maxNodes: number;
    includeCode: boolean;
  }): Promise<CodeGraphResult> {
    if (typeof input.query !== "string" || codePoints(input.query) === 0 || codePoints(input.query) > 500) {
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph query is invalid");
    }
    if (!Number.isSafeInteger(input.maxNodes) || input.maxNodes < 1 || input.maxNodes > 100) {
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph result limit is invalid");
    }

    const project = await resolveProjectPath(input.projectRoot);
    const handle = await this.#open(project.root);
    const observedAt = this.#now();
    let context: UpstreamContext;
    try {
      await handle.sync();
      context = await handle.buildContext(input.query, {
        maxNodes: input.maxNodes,
        includeCode: input.includeCode,
        format: "json",
      });
    } catch {
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph query failed");
    }

    const pendingFiles = pendingPaths(handle);
    const pending = new Set(pendingFiles);
    const parsedContext = parseJsonContext(context);
    if (typeof parsedContext === "string") {
      return {
        query: input.query,
        state: pendingFiles.length === 0 ? "ready" : "stale",
        nodes: [
          {
            id: "codegraph-context",
            kind: "context",
            name: "CodeGraph context",
            snippet: parsedContext.slice(0, 32 * 1024),
            stale: pendingFiles.length > 0,
          },
        ],
        edges: [],
        pendingFiles,
        observedAt,
        limitations: pendingFiles.length === 0 ? [] : ["Read pending files before relying on graph results."],
      };
    }

    const snippets = new Map(parsedContext.codeBlocks?.map((block) => [block.nodeId, block.code]) ?? []);
    const nodes = parsedContext.subgraph.nodes.slice(0, input.maxNodes).map((node) => {
      const path = safePath(node.filePath);
      return {
        id: node.id,
        kind: node.kind,
        name: node.name,
        ...(path === undefined ? {} : { path }),
        ...(node.startLine === undefined ? {} : { startLine: node.startLine }),
        ...(node.endLine === undefined ? {} : { endLine: node.endLine }),
        ...(input.includeCode && snippets.has(node.id) ? { snippet: snippets.get(node.id) } : {}),
        stale: path !== undefined && pending.has(path),
      };
    });
    return {
      query: input.query,
      state: pendingFiles.length === 0 ? "ready" : "stale",
      nodes,
      edges: parsedContext.subgraph.edges.map((edge) => ({ from: edge.source, to: edge.target, kind: edge.kind })),
      pendingFiles,
      observedAt,
      limitations: pendingFiles.length === 0 ? [] : ["Read pending files before relying on graph results."],
    };
  }

  async status(projectPath: string): Promise<CodeGraphStatus> {
    const project = await resolveProjectPath(projectPath);
    const openProject = this.#projects.get(project.root);
    if (openProject === undefined) {
      return observedStatus(
        existsSync(join(project.root, ".codegraph", "codegraph.db")) ? "ready" : "missing",
        [],
        this.#now(),
      );
    }
    this.#touch(project.root, openProject);
    const pendingFiles = pendingPaths(openProject.handle);
    return observedStatus(pendingFiles.length === 0 ? "ready" : "pending", pendingFiles, this.#now());
  }

  async close(): Promise<void> {
    for (const project of this.#projects.values()) {
      project.handle.unwatch();
      project.handle.close();
    }
    this.#projects.clear();
  }

  async #getApi(): Promise<CodeGraphApi> {
    this.#api ??= await this.#load();
    return this.#api;
  }

  async #open(root: string): Promise<CodeGraphHandle> {
    const existing = this.#projects.get(root);
    if (existing !== undefined) {
      this.#touch(root, existing);
      return existing.handle;
    }
    let handle: CodeGraphHandle;
    try {
      handle = await (await this.#getApi()).open(root);
      handle.watch();
      await handle.waitUntilWatcherReady?.();
    } catch {
      throw new LocalBrainError("codegraph_missing", "CodeGraph index is unavailable; run wagglebot brain init");
    }
    this.#remember(root, handle);
    return handle;
  }

  #remember(root: string, handle: CodeGraphHandle): void {
    while (this.#projects.size >= this.#maxOpenProjects) {
      const oldest = this.#projects.entries().next().value as [string, OpenProject] | undefined;
      if (oldest === undefined) break;
      this.#projects.delete(oldest[0]);
      oldest[1].handle.unwatch();
      oldest[1].handle.close();
    }
    this.#projects.set(root, { handle, observedAt: this.#now() });
  }

  #touch(root: string, project: OpenProject): void {
    this.#projects.delete(root);
    this.#projects.set(root, project);
  }
}
