import type { ProjectIdentity } from "@wagglebot/contracts";

export type { ProjectIdentity } from "@wagglebot/contracts";

export type LocalMemorySection = "Architecture" | "Conventions" | "Commands" | "Decisions" | "Warnings" | "Learnings";

export type LocalMemoryPath = `.agents/memory/${string}.md`;
export type LocalMemoryIndexState = "current" | "stale" | "missing";

export type MemoryEvidence = {
  kind: "file" | "commit" | "adr" | "issue" | "test" | "maintainer_confirmation";
  ref: string;
};

export type LocalMemoryChunk = {
  id: string;
  path: LocalMemoryPath;
  type: string;
  title: string;
  description?: string;
  tags: string[];
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};

export type LocalMemoryConcept = {
  path: LocalMemoryPath;
  relativePath: string;
  text: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  type: string;
  title: string;
  description?: string;
  tags: string[];
  body: string;
  chunks: LocalMemoryChunk[];
};

export type LocalMemoryReservedFile = {
  path: LocalMemoryPath;
  text: string;
  contentHash: string;
};

export type LocalMemoryBundle = {
  path: ".agents/memory";
  concepts: LocalMemoryConcept[];
  indexes: LocalMemoryReservedFile[];
  logs: LocalMemoryReservedFile[];
  bundleHash: string;
  totalBytes: number;
  indexState: LocalMemoryIndexState;
};

export type LocalMemoryHit = LocalMemoryChunk & { score: number };
export type LocalMemorySearchResult = { hits: LocalMemoryHit[]; bundleHash?: string };

export type LocalMemoryProposalInput = {
  projectRoot: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { path: LocalMemoryPath; contentHash: string };
};

export type LocalMemoryIndexChange = { path: LocalMemoryPath; content: string };

export type LocalMemoryProposal = {
  proposalId: string;
  baseBundleHash: string;
  path: LocalMemoryPath;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { path: LocalMemoryPath; contentHash: string };
  action: "add" | "replace" | "no_change" | "needs_resolution";
  content: string;
  indexChanges: LocalMemoryIndexChange[];
  patch: string;
  warnings: string[];
};

export type LocalMemorySaveResult = {
  path: LocalMemoryPath;
  action: "add" | "replace";
  previousBundleHash: string;
  newBundleHash: string;
  patch: string;
  warnings: string[];
};

export type CodeGraphStatus = {
  state: "missing" | "indexing" | "ready" | "pending" | "error";
  pendingFiles: string[];
  observedAt: string;
};

export type CodeGraphResult = {
  query: string;
  state: "ready" | "pending" | "stale";
  nodes: Array<{
    id: string;
    kind: string;
    name: string;
    path?: string;
    startLine?: number;
    endLine?: number;
    snippet?: string;
    stale: boolean;
  }>;
  edges: Array<{ from: string; to: string; kind: string }>;
  pendingFiles: string[];
  observedAt: string;
  limitations: string[];
};

export type GitStatus = {
  state: "ready" | "error";
  head?: string;
  branch?: string;
  workingTree?: "clean" | "dirty";
  shallow: boolean;
};

export type GitCommit = {
  commit: string;
  subject: string;
  body?: string;
  authorDate: string;
  authors: string[];
  changedPaths: string[];
};

export type GitWhyInput = {
  projectRoot: string;
  path: string;
  startLine?: number;
  endLine?: number;
  query?: string;
  maxCommits?: number;
};

export type GitWhyResult = {
  path: string;
  requestedLines?: { start: number; end: number };
  workingTree: "clean" | "dirty";
  head: string;
  evidence: Array<
    GitCommit & {
      reason: "blame" | "exact_hash" | "bm25" | "recent_path_change";
      score: number;
      diffHunks: string[];
    }
  >;
  limitations: string[];
};

export type LocalBrainStatus = {
  project: ProjectIdentity;
  memory: {
    path: ".agents/memory";
    state: "missing" | "ready" | "invalid" | "error";
    bundleHash?: string;
    conceptCount?: number;
    totalBytes?: number;
    indexState?: LocalMemoryIndexState;
    observedAt: string;
  };
  codeGraph: CodeGraphStatus;
  git: GitStatus;
  observedAt: string;
};
