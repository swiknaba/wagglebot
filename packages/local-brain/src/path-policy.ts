import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type LocalBrainErrorCode =
  | "path_forbidden"
  | "path_outside_repository"
  | "project_not_found"
  | "local_memory_invalid"
  | "local_memory_too_large"
  | "memory_changed"
  | "proposal_invalid"
  | "proposal_conflict"
  | "secret_rejected"
  | "codegraph_missing"
  | "codegraph_unavailable"
  | "local_brain_internal";

export class LocalBrainError extends Error {
  constructor(
    readonly code: LocalBrainErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type GitExecutor = (args: string[], cwd: string) => Promise<string>;

export type ResolvedProject = {
  root: string;
  projectPath: string;
};

export const executeGit: GitExecutor = async (args, cwd) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await process.exited) !== 0) throw new LocalBrainError("project_not_found", "Git repository is unavailable");
  return new Response(process.stdout).text();
};

export const assertInside = (root: string, candidate: string): void => {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  ) {
    return;
  }
  throw new LocalBrainError("path_outside_repository", "requested path resolves outside Git root");
};

export const isSecretPath = (relativePath: string): boolean => {
  const segments = relativePath.split(/[\\/]/u);
  return segments.some(
    (segment) => /^\.env/i.test(segment) || /\.(pem|key)$/i.test(segment) || /^(credentials|secrets)$/i.test(segment),
  );
};

export const resolveProjectPath = async (input: string, git: GitExecutor = executeGit): Promise<ResolvedProject> => {
  if (input.includes("\0") || !isAbsolute(input)) {
    throw new LocalBrainError("project_not_found", "project path must be absolute");
  }

  let projectPath: string;
  try {
    projectPath = await realpath(input);
  } catch {
    throw new LocalBrainError("project_not_found", "project path is unavailable");
  }

  let reportedRoot: string;
  try {
    reportedRoot = (await git(["rev-parse", "--show-toplevel"], projectPath)).trim();
  } catch (error) {
    if (error instanceof LocalBrainError) throw error;
    throw new LocalBrainError("project_not_found", "Git repository is unavailable");
  }

  try {
    const root = await realpath(reportedRoot);
    assertInside(root, projectPath);
    return { root, projectPath };
  } catch (error) {
    if (error instanceof LocalBrainError) throw error;
    throw new LocalBrainError("project_not_found", "Git root is unavailable");
  }
};

export const resolveSafeFile = async (project: ResolvedProject, input: string): Promise<string> => {
  if (input.includes("\0") || isAbsolute(input)) {
    throw new LocalBrainError("path_forbidden", "requested file path must be relative");
  }

  let file: string;
  try {
    file = await realpath(resolve(project.root, input));
  } catch {
    throw new LocalBrainError("path_forbidden", "requested file is unavailable");
  }

  assertInside(project.root, file);
  if (isSecretPath(relative(project.root, file))) {
    throw new LocalBrainError("path_forbidden", "requested file path is forbidden");
  }
  return file;
};
