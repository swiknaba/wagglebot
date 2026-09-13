import type { LocalBrainStatus } from "@wagglebot/local-brain";

export type BrainStatusBrain = { status(projectPath: string): Promise<LocalBrainStatus> };

export async function runBrainStatus(input: {
  projectPath: string;
  brain: BrainStatusBrain;
  json: boolean;
  write: (line: string) => void;
}): Promise<number> {
  try {
    const status = await input.brain.status(input.projectPath);
    if (input.json) {
      input.write(JSON.stringify({ schemaVersion: 1, status }));
      return 0;
    }
    input.write(`Component memory  ${status.memory.state}  .agents/memory.md`);
    input.write(
      `Code graph         ${status.codeGraph.state}  ${status.codeGraph.pendingFiles.length === 0 ? "no pending files" : `${status.codeGraph.pendingFiles.length} pending files`}`,
    );
    input.write(
      `Git                ${status.git.state}  ${status.git.branch ?? "detached"}@${(status.git.head ?? "unknown").slice(0, 7)}, ${status.git.workingTree ?? "unknown"}`,
    );
    input.write(`Catalog            ${status.project.catalogState}`);
    input.write("Shared memory      not checked by this command");
    return 0;
  } catch (error) {
    input.write(`brain status: ${error instanceof Error ? error.message : "status unavailable"}`);
    return 1;
  }
}
