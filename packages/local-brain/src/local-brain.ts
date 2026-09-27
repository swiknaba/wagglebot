import type { ProjectIdentity } from "@wagglebot/contracts";

import { CodeGraphProvider } from "./codegraph/provider";
import { GitProvider } from "./git/provider";
import { MarkdownMemoryProvider } from "./memory/provider";
import { LocalBrainError } from "./path-policy";
import { identifyProject } from "./project-identity";
import type { CodeGraphStatus, GitStatus, LocalBrainStatus, LocalMemoryBundle } from "./types";

type MemoryStatusProvider = { read(projectPath: string): Promise<LocalMemoryBundle | undefined> };
type CodeStatusProvider = { status(projectPath: string): Promise<CodeGraphStatus>; close(): Promise<void> };
type GitStatusProvider = { status(projectPath: string): Promise<GitStatus> };

export type LocalBrain = {
  identify(projectPath: string): Promise<ProjectIdentity>;
  memory: MarkdownMemoryProvider | MemoryStatusProvider;
  code: CodeGraphProvider | CodeStatusProvider;
  git: GitProvider | GitStatusProvider;
  status(projectPath: string): Promise<LocalBrainStatus>;
  close(): Promise<void>;
};

export const createLocalBrain = (
  options: {
    identity?: (projectPath: string) => Promise<ProjectIdentity>;
    memory?: MarkdownMemoryProvider | MemoryStatusProvider;
    code?: CodeGraphProvider | CodeStatusProvider;
    git?: GitProvider | GitStatusProvider;
  } = {},
): LocalBrain => {
  const memory = options.memory ?? new MarkdownMemoryProvider();
  const code = options.code ?? new CodeGraphProvider();
  const git = options.git ?? new GitProvider();
  const identify = options.identity ?? identifyProject;
  let closed = false;
  return {
    identify,
    memory,
    code,
    git,
    async status(projectPath) {
      const now = new Date().toISOString();
      const [project, memoryResult, codeResult, gitResult] = await Promise.allSettled([
        identify(projectPath),
        memory.read(projectPath),
        code.status(projectPath),
        git.status(projectPath),
      ]);
      const projectIdentity =
        project.status === "fulfilled"
          ? project.value
          : { workingTree: "dirty" as const, catalogState: "missing" as const, catalogWarning: "identity unavailable" };
      const memoryStatus =
        memoryResult.status === "fulfilled" && memoryResult.value !== undefined
          ? {
              path: ".agents/memory" as const,
              state: "ready" as const,
              bundleHash: memoryResult.value.bundleHash,
              conceptCount: memoryResult.value.concepts.length,
              totalBytes: memoryResult.value.totalBytes,
              indexState: memoryResult.value.indexState,
              observedAt: now,
            }
          : {
              path: ".agents/memory" as const,
              state:
                memoryResult.status === "fulfilled"
                  ? ("missing" as const)
                  : memoryResult.reason instanceof LocalBrainError &&
                      ["local_memory_invalid", "local_memory_too_large", "path_outside_repository"].includes(
                        memoryResult.reason.code,
                      )
                    ? ("invalid" as const)
                    : ("error" as const),
              observedAt: now,
            };
      return {
        project: projectIdentity,
        memory: memoryStatus,
        codeGraph:
          codeResult.status === "fulfilled"
            ? codeResult.value
            : { state: "error" as const, pendingFiles: [], observedAt: now },
        git: gitResult.status === "fulfilled" ? gitResult.value : { state: "error" as const, shallow: false },
        observedAt: now,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await code.close();
    },
  };
};
