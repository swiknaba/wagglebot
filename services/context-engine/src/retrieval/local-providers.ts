import { createHash } from "node:crypto";
import type { EvidenceRef } from "@wagglebot/contracts";
import type { CodeGraphResult, CodeGraphStatus, LocalBrain } from "@wagglebot/local-brain";
import type { ContextRequest } from "../planning/query-plan";
import type { SharedMemoryClient } from "../shared/client";
import type { ContextProvider, Providers } from "./run";
import type { RetrievalCandidate } from "./types";

const requestText = (request: ContextRequest): string => {
  if (request.mode === "search") return request.input.query;
  if (request.mode === "wake")
    return request.input.task ?? (request.input.level === 1 ? "project purpose architecture warnings decisions" : "");
  return [request.input.query, request.input.symbol, request.input.path].filter(Boolean).join(" ");
};

const rank = (name: string, position: number, weight: number) => [{ name, rank: position + 1, weight }];

export function createLocalProviders(brain: LocalBrain, shared?: SharedMemoryClient): Providers {
  const providers: Providers = {};
  const memory: ContextProvider = async (request) => {
    const query = requestText(request);
    if (!query) return [];
    const projectPath = request.input.projectPath;
    const result = await brain.memory.search({ projectRoot: projectPath, query, limit: 10 });
    const hits =
      request.mode === "wake" && request.input.level === 1
        ? result.hits.filter((hit) => ["Purpose", "Warning", "Decision"].includes(hit.type))
        : result.hits;
    return hits.map(
      (hit, index) =>
        ({
          id: `local:${hit.id}`,
          source: "local_memory",
          scope: "component",
          kind: hit.type,
          title: hit.title,
          content: hit.content,
          contentHash: hit.contentHash,
          exactMatch: query
            .toLowerCase()
            .split(/\s+/u)
            .some((part) => hit.title.toLowerCase().includes(part)),
          identityKey: `local:${hit.path}:${hit.title.toLowerCase()}`,
          provenance: [
            {
              kind: "local_memory",
              path: hit.path,
              startLine: hit.startLine,
              endLine: hit.endLine,
              contentHash: hit.contentHash,
            },
          ],
          freshness: "live",
          authorityTier: 60,
          channels: rank("local_memory_bm25", index, 1.25),
          updatedAt: undefined,
        }) satisfies RetrievalCandidate,
    );
  };
  providers.local_memory = memory;

  providers.code = async (request, signal) => {
    const query = requestText(request);
    if (!query) return [];
    if (request.mode === "wake" && request.input.level === 1) {
      const codeStatus = brain.code as LocalBrain["code"] & { status?: (projectPath: string) => Promise<unknown> };
      if (!codeStatus.status) return [];
      const status = (await codeStatus.status(request.input.projectPath)) as CodeGraphStatus;
      return {
        candidates: [],
        codeGraph: {
          state: status.state === "indexing" ? "pending" : status.state,
          pendingFiles: status.pendingFiles,
        },
      };
    }
    const code = brain.code as unknown as {
      exploreContext?: (input: {
        projectRoot: string;
        query: string;
        maxNodes: number;
        includeCode: boolean;
        signal?: AbortSignal;
      }) => Promise<CodeGraphResult>;
    };
    if (typeof code.exploreContext !== "function") throw new Error("provider_missing");
    const result = await code.exploreContext({
      projectRoot: request.input.projectPath,
      query: Array.from(query).slice(0, 500).join(""),
      maxNodes: 12,
      includeCode: true,
      signal,
    });
    const candidates = result.nodes.flatMap((node, index) => {
      if (!node.path || !node.startLine || !node.endLine) return [];
      const provenance: EvidenceRef = {
        kind: "code",
        path: node.path,
        startLine: node.startLine,
        endLine: node.endLine,
        ...(node.name ? { symbol: node.name } : {}),
        graphState: node.stale ? "stale" : result.state === "pending" ? "pending" : "ready",
      };
      return [
        {
          id: `code:${node.id}`,
          source: "code",
          kind: node.kind,
          title: node.name,
          content: node.snippet ?? node.name,
          contentHash: createHash("sha256")
            .update(
              JSON.stringify({
                identity: {
                  path: node.path,
                  name: node.name,
                  kind: node.kind,
                  startLine: node.startLine,
                  endLine: node.endLine,
                },
                content: node.snippet ?? node.name,
              }),
            )
            .digest("hex"),
          exactMatch:
            (request.mode === "explain" &&
              ((request.input.symbol !== undefined && node.name.toLowerCase() === request.input.symbol.toLowerCase()) ||
                (request.input.path !== undefined && node.path === request.input.path))) ||
            node.name.toLowerCase() === query.toLowerCase() ||
            node.path === query,
          identityKey: node.path ? `source:${node.path}:${node.name}` : undefined,
          provenance: [provenance],
          freshness: provenance.graphState === "ready" ? "live" : "stale",
          authorityTier: provenance.graphState === "ready" ? 90 : 70,
          channels: rank("code_exact", index, 1.4),
        } satisfies RetrievalCandidate,
      ];
    });
    return {
      candidates,
      codeGraph: {
        state: result.state === "stale" ? "pending" : result.state,
        pendingFiles: result.pendingFiles,
      },
    };
  };

  providers.git = async (request) => {
    const query = requestText(request);
    if (!query || !("history" in brain.git)) return [];
    const path = request.mode === "explain" ? request.input.path : undefined;
    if (request.mode === "explain" && path && "why" in brain.git) {
      const explanation = await brain.git.why({
        projectRoot: request.input.projectPath,
        path,
        ...(request.input.startLine !== undefined && request.input.endLine !== undefined
          ? { startLine: request.input.startLine, endLine: request.input.endLine }
          : {}),
        query,
        maxCommits: 10,
      });
      return explanation.evidence.map(
        (commit, index) =>
          ({
            id: `git:${commit.commit}`,
            source: "git",
            kind: "commit",
            title: commit.subject,
            content: [commit.subject, commit.body, ...commit.diffHunks].filter(Boolean).join("\n"),
            contentHash: commit.commit,
            exactMatch: commit.reason === "blame" || commit.reason === "exact_hash",
            provenance: [
              {
                kind: "git",
                commit: commit.commit,
                path,
                ...(request.input.startLine !== undefined && request.input.endLine !== undefined
                  ? { startLine: request.input.startLine, endLine: request.input.endLine }
                  : {}),
              },
            ],
            freshness: "historical",
            authorityTier: 70,
            channels: rank(
              commit.reason === "blame" || commit.reason === "exact_hash" ? "git_blame" : "git_history",
              index,
              commit.reason === "blame" || commit.reason === "exact_hash" ? 1.25 : 1.1,
            ),
            updatedAt: commit.authorDate,
          }) satisfies RetrievalCandidate,
      );
    }
    const history = await brain.git.history({ projectRoot: request.input.projectPath, path, limit: 10 });
    const ordered = [...history.commits].sort(
      (a, b) =>
        Number(b.subject.toLowerCase().includes(query.toLowerCase())) -
        Number(a.subject.toLowerCase().includes(query.toLowerCase())),
    );
    return ordered.map(
      (commit, index) =>
        ({
          id: `git:${commit.commit}`,
          source: "git",
          kind: "commit",
          title: commit.subject,
          content: commit.subject,
          contentHash: commit.commit,
          exactMatch: query.match(/[a-f0-9]{7,64}/iu)?.[0] === commit.commit || query === commit.subject,
          provenance: [{ kind: "git", commit: commit.commit, ...(path ? { path } : {}) }],
          freshness: "historical",
          authorityTier: 70,
          channels: rank(path ? "git_blame" : "git_history", index, path ? 1.25 : 1.1),
          updatedAt: commit.authorDate,
        }) satisfies RetrievalCandidate,
    );
  };

  if (shared)
    providers.shared_memory = async (request, signal) => {
      const prepared = request.sharedRequest;
      if (!prepared) throw new Error("provider_missing");
      const results =
        prepared.purpose === "wake" ? await shared.wake(prepared, signal) : await shared.search(prepared, signal);
      const eligible = results.records.filter(
        ({ record, score }) =>
          request.mode !== "wake" ||
          request.input.level === undefined ||
          request.input.level < 2 ||
          (record.confidence === "high" && score >= 0.5),
      );
      return eligible.map(
        ({ record }, index) =>
          ({
            id: `shared:${record.id}`,
            source: "shared_memory",
            scope: record.scope.kind === "system" ? "system" : record.scope.kind === "domain" ? "domain" : "org",
            kind: record.kind,
            title: record.title,
            content: record.content,
            contentHash: record.contentHash,
            exactMatch: false,
            identityKey: record.identityKey,
            provenance: [
              {
                kind: "shared_memory",
                memoryId: record.id,
                ...(record.provenance[0]?.repository ? { repository: record.provenance[0].repository } : {}),
                ...(record.provenance[0]?.path ? { path: record.provenance[0].path } : {}),
                ...(record.provenance[0]?.commitSha ? { commitSha: record.provenance[0].commitSha } : {}),
                ...(record.provenance[0]?.heading ? { heading: record.provenance[0].heading } : {}),
              },
            ],
            freshness: "unknown",
            authorityTier: record.confidence === "high" ? 50 : record.confidence === "medium" ? 40 : 30,
            channels: rank("shared_semantic", index, 1),
            updatedAt: record.updatedAt,
            ...(record.supersedes ? { supersedes: record.supersedes } : {}),
            ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
          }) satisfies RetrievalCandidate,
      );
    };
  return providers;
}
