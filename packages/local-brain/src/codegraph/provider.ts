import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

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

type UpstreamCodeBlock =
  | { nodeId: string; code: string }
  | {
      filePath: string;
      startLine: number;
      endLine: number;
      content: string;
      nodeName?: string;
      nodeKind?: string;
    };

type UpstreamContext =
  | string
  | {
      subgraph: { nodes: UpstreamNode[]; edges: Array<{ source: string; target: string; kind: string }> };
      codeBlocks?: UpstreamCodeBlock[];
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
  open(
    root: string,
    options?: { synchronize?: boolean; watch?: boolean; signal?: AbortSignal },
  ): Promise<CodeGraphHandle>;
  getDatabasePath?(root: string): string;
};

export type CodeGraphProviderOptions = {
  api?: CodeGraphApi;
  load?: () => Promise<CodeGraphApi>;
  maxOpenProjects?: number;
  now?: () => string;
};

type OpenProject = { handle: CodeGraphHandle; observedAt: string; watching: boolean };

const codePoints = (value: string): number => [...value].length;

const defaultLoader = async (): Promise<CodeGraphApi> => {
  process.env.CODEGRAPH_TELEMETRY ??= "0";
  const packageName = "@colbymchenry/codegraph";
  const module = (await import(packageName)) as { default?: unknown; getDatabasePath?: (root: string) => string };
  const upstream = module.default as
    | {
        init(root: string): Promise<CodeGraphHandle>;
        open(root: string, options?: { sync?: boolean }): Promise<CodeGraphHandle>;
        getDatabasePath?(root: string): string;
      }
    | undefined;
  if (upstream === undefined) throw new LocalBrainError("codegraph_unavailable", "CodeGraph SDK is unavailable");
  return {
    init: (root) => upstream.init(root),
    getDatabasePath: module.getDatabasePath ?? upstream.getDatabasePath,
    async open(root, options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      if (
        options?.synchronize === false &&
        !isCurrentInitializedIndex(module.getDatabasePath?.(root) ?? upstream.getDatabasePath?.(root))
      ) {
        throw new LocalBrainError("codegraph_missing", "CodeGraph index requires recovery");
      }
      const handle = await upstream.open(root, options?.synchronize === false ? { sync: false } : undefined);
      if (options?.signal?.aborted) {
        handle.close();
        throw options.signal.reason;
      }
      return handle;
    },
  };
};

const isCurrentInitializedIndex = (path: string | undefined): boolean => {
  if (!path || !existsSync(path)) return false;
  try {
    const walPath = `${path}-wal`;
    if (existsSync(walPath) && statSync(walPath).size > 0) return false;
    const databaseUrl = new URL(pathToFileURL(path).href);
    databaseUrl.searchParams.set("immutable", "1");
    const database = new Database(databaseUrl.href, { readonly: true, create: false });
    try {
      const tables = new Set(
        database
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map(({ name }) => name),
      );
      if (!["schema_versions", "nodes", "edges", "nodes_fts"].every((table) => tables.has(table))) return false;
      const versions = database
        .query<{ version: number }, []>("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
        .get();
      return versions?.version === 9;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
};

const safePath = (path: string | undefined): string | undefined =>
  path === undefined || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes("..")
    ? undefined
    : path;

const normalizedPath = (path: string | undefined): string | undefined => {
  const safe = safePath(path);
  if (safe === undefined) return undefined;
  const normalized = safe
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  return normalized.length === 0 ? undefined : normalized;
};

const codeSnippets = (nodes: UpstreamNode[], blocks: UpstreamCodeBlock[] | undefined): Map<string, string> => {
  const snippets = new Map<string, string>();
  const ambiguous = new Set<string>();
  const remember = (id: string, code: string): void => {
    if (ambiguous.has(id)) return;
    if (snippets.has(id)) {
      snippets.delete(id);
      ambiguous.add(id);
      return;
    }
    snippets.set(id, code);
  };

  for (const block of blocks ?? []) {
    if ("nodeId" in block) {
      remember(block.nodeId, block.code);
      continue;
    }
    const path = normalizedPath(block.filePath);
    if (path === undefined) continue;
    const matches = nodes.filter(
      (node) =>
        normalizedPath(node.filePath) === path &&
        node.startLine === block.startLine &&
        node.endLine === block.endLine &&
        (block.nodeName === undefined || node.name === block.nodeName) &&
        (block.nodeKind === undefined || node.kind === block.nodeKind),
    );
    if (matches.length === 1) {
      const [match] = matches;
      if (match) remember(match.id, block.content);
    }
  }
  return snippets;
};

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
      codeBlocks?: UpstreamCodeBlock[];
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
    this.#remember(project.root, handle, true);
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

    const snippets = codeSnippets(parsedContext.subgraph.nodes, parsedContext.codeBlocks);
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

  async exploreContext(input: {
    projectRoot: string;
    query: string;
    maxNodes: number;
    includeCode: boolean;
    signal?: AbortSignal;
  }): Promise<CodeGraphResult> {
    if (typeof input.query !== "string" || codePoints(input.query) === 0 || codePoints(input.query) > 500) {
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph query is invalid");
    }
    if (!Number.isSafeInteger(input.maxNodes) || input.maxNodes < 1 || input.maxNodes > 100) {
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph result limit is invalid");
    }
    if (input.signal?.aborted) throw input.signal.reason;
    const project = await resolveProjectPath(input.projectRoot);
    const handle = await this.#openContext(project.root, input.signal);
    const observedAt = this.#now();
    try {
      const context = await handle.buildContext(input.query, {
        maxNodes: input.maxNodes,
        includeCode: input.includeCode,
        format: "json",
      });
      if (input.signal?.aborted) throw input.signal.reason;
      const pendingFiles = pendingPaths(handle);
      const parsed = parseJsonContext(context);
      if (typeof parsed === "string") {
        return {
          query: input.query,
          state: pendingFiles.length ? "stale" : "ready",
          nodes: [
            {
              id: "codegraph-context",
              kind: "context",
              name: "CodeGraph context",
              snippet: parsed.slice(0, 32 * 1024),
              stale: pendingFiles.length > 0,
            },
          ],
          edges: [],
          pendingFiles,
          observedAt,
          limitations: pendingFiles.length ? ["Read pending files before relying on graph results."] : [],
        };
      }
      const pending = new Set(pendingFiles);
      const snippets = codeSnippets(parsed.subgraph.nodes, parsed.codeBlocks);
      return {
        query: input.query,
        state: pendingFiles.length ? "stale" : "ready",
        nodes: parsed.subgraph.nodes.slice(0, input.maxNodes).map((node) => {
          const path = safePath(node.filePath);
          return {
            id: node.id,
            kind: node.kind,
            name: node.name,
            ...(path ? { path } : {}),
            ...(node.startLine ? { startLine: node.startLine } : {}),
            ...(node.endLine ? { endLine: node.endLine } : {}),
            ...(input.includeCode && snippets.has(node.id) ? { snippet: snippets.get(node.id) } : {}),
            stale: path !== undefined && pending.has(path),
          };
        }),
        edges: parsed.subgraph.edges.map((edge) => ({ from: edge.source, to: edge.target, kind: edge.kind })),
        pendingFiles,
        observedAt,
        limitations: pendingFiles.length ? ["Read pending files before relying on graph results."] : [],
      };
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      throw new LocalBrainError("codegraph_unavailable", "CodeGraph query failed");
    }
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
      if (project.watching) project.handle.unwatch();
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
    this.#remember(root, handle, true);
    return handle;
  }

  async #openContext(root: string, signal?: AbortSignal): Promise<CodeGraphHandle> {
    const existing = this.#projects.get(root);
    if (existing !== undefined) {
      this.#touch(root, existing);
      return existing.handle;
    }
    if (signal?.aborted) throw signal.reason;
    let handle: CodeGraphHandle;
    try {
      handle = await (await this.#getApi()).open(root, { synchronize: false, watch: false, signal });
      if (signal?.aborted) {
        handle.close();
        throw signal.reason;
      }
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new LocalBrainError("codegraph_missing", "CodeGraph index is unavailable or requires repair");
    }
    this.#remember(root, handle, false);
    return handle;
  }

  #remember(root: string, handle: CodeGraphHandle, watching: boolean): void {
    while (this.#projects.size >= this.#maxOpenProjects) {
      const oldest = this.#projects.entries().next().value as [string, OpenProject] | undefined;
      if (oldest === undefined) break;
      this.#projects.delete(oldest[0]);
      if (oldest[1].watching) oldest[1].handle.unwatch();
      oldest[1].handle.close();
    }
    this.#projects.set(root, { handle, observedAt: this.#now(), watching });
  }

  #touch(root: string, project: OpenProject): void {
    this.#projects.delete(root);
    this.#projects.set(root, project);
  }
}
