import type { ProjectIdentity } from "@wagglebot/contracts";

import { CodeGraphProvider } from "./codegraph/provider";
import { GitProvider } from "./git/provider";
import { MarkdownMemoryProvider } from "./memory/provider";
import { identifyProject } from "./project-identity";
import type { CodeGraphStatus, GitStatus, LocalBrainStatus } from "./types";

type MemoryStatusProvider = { read(projectPath: string): Promise<{ contentHash: string } | undefined> };
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
      return {
        project: projectIdentity,
        memory:
          memoryResult.status === "fulfilled" && memoryResult.value !== undefined
            ? { state: "ready" as const, contentHash: memoryResult.value.contentHash, observedAt: now }
            : {
                state: memoryResult.status === "fulfilled" ? ("missing" as const) : ("error" as const),
                observedAt: now,
              },
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
