import type { ProjectIdentity } from "@wagglebot/contracts";

export type { ProjectIdentity } from "@wagglebot/contracts";

export type LocalMemorySection = "Architecture" | "Conventions" | "Commands" | "Decisions" | "Warnings" | "Learnings";

export type MemoryEvidence = {
  kind: "file" | "commit" | "adr" | "issue" | "test" | "maintainer_confirmation";
  ref: string;
};

export type LocalMemoryChunk = {
  id: string;
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};

export type LocalMemoryHit = LocalMemoryChunk & {
  path: ".agents/memory.md";
  score: number;
};

export type LocalMemoryProposalInput = {
  projectRoot: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  replace?: { title: string; contentHash: string };
};

export type LocalMemoryProposal = {
  proposalId: string;
  baseContentHash: string;
  section: LocalMemorySection;
  title: string;
  summary: string;
  evidence: MemoryEvidence[];
  action: "add" | "replace" | "no_change" | "needs_resolution";
  patch: string;
  warnings: string[];
};

export type LocalMemorySaveResult = {
  path: ".agents/memory.md";
  action: "add" | "replace";
  previousContentHash: string;
  newContentHash: string;
  patch: string;
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
  memory: { state: "missing" | "ready" | "error"; contentHash?: string; observedAt: string };
  codeGraph: CodeGraphStatus;
  git: GitStatus;
  observedAt: string;
};
