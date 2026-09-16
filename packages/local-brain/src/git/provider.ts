import { Bm25Index } from "../bm25/index";
import { LocalBrainError, resolveProjectPath, resolveSafeFile } from "../path-policy";
import type { GitCommit, GitStatus, GitWhyInput, GitWhyResult } from "../types";
import { parseBlameCommits, parseLog } from "./parse";
import { GitRunner } from "./runner";

const LOG_FORMAT = "%x1e%H%x00%s%x00%b%x00%aI%x00%an%x00";
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_LINES = 200;

const assertLimit = (limit: number, maximum: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new LocalBrainError("local_brain_internal", "Git result limit is invalid");
};

export class GitProvider {
  constructor(private readonly runner = new GitRunner()) {}

  async status(projectPath: string): Promise<GitStatus> {
    const project = await resolveProjectPath(projectPath);
    const [head, branch, porcelain, shallow] = await Promise.all([
      this.runner.run(project.root, ["rev-parse", "HEAD"]),
      this.runner.run(project.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      this.runner.run(project.root, ["status", "--porcelain=v2", "-z"]),
      this.runner.run(project.root, ["rev-parse", "--is-shallow-repository"]),
    ]);
    return {
      state: "ready",
      head: head.trim(),
      branch: branch.trim() === "HEAD" ? undefined : branch.trim(),
      workingTree: porcelain === "" ? "clean" : "dirty",
      shallow: shallow.trim() === "true",
    };
  }

  async history(input: {
    projectRoot: string;
    path?: string;
    limit: number;
  }): Promise<{ commits: GitCommit[]; limitations: string[] }> {
    assertLimit(input.limit, 100);
    const project = await resolveProjectPath(input.projectRoot);
    const path = input.path === undefined ? undefined : await this.#safePath(project, input.path);
    const args = ["log", "--follow", `--max-count=${input.limit}`, `--format=${LOG_FORMAT}`, "--name-only", "-z", "--"];
    if (path !== undefined) args.push(path);
    const commits = parseLog(await this.runner.run(project.root, args));
    return { commits, limitations: [] };
  }

  async recent(input: {
    projectRoot: string;
    limit: number;
  }): Promise<{ commits: GitCommit[]; limitations: string[] }> {
    return this.history(input);
  }

  async blame(input: { projectRoot: string; path: string; startLine: number; endLine: number }): Promise<string[]> {
    if (
      !Number.isSafeInteger(input.startLine) ||
      !Number.isSafeInteger(input.endLine) ||
      input.startLine < 1 ||
      input.endLine < input.startLine
    ) {
      throw new LocalBrainError("local_brain_internal", "Git blame line range is invalid");
    }
    const project = await resolveProjectPath(input.projectRoot);
    const path = await this.#safePath(project, input.path);
    return parseBlameCommits(
      await this.runner.run(project.root, [
        "blame",
        "--line-porcelain",
        "-L",
        `${input.startLine},${input.endLine}`,
        "--",
        path,
      ]),
    );
  }

  async why(input: GitWhyInput): Promise<GitWhyResult> {
    const maxCommits = input.maxCommits ?? 100;
    assertLimit(maxCommits, 200);
    const project = await resolveProjectPath(input.projectRoot);
    const path = await this.#safePath(project, input.path);
    const [status, history] = await Promise.all([
      this.status(project.root),
      this.#history(project.root, path, maxCommits),
    ]);
    const blamed =
      input.startLine === undefined || input.endLine === undefined
        ? []
        : await this.blame({ projectRoot: project.root, path, startLine: input.startLine, endLine: input.endLine });
    const query = input.query ?? "";
    const ranked = new Bm25Index(
      history.commits,
      (commit) => [commit.subject, commit.body, ...commit.changedPaths].filter(Boolean).join("\n"),
      (commit) => commit.commit,
    ).search(query, 5);
    const exact = new Set(query.match(/\b[0-9a-f]{7,64}\b/giu) ?? []);
    const rankedCommits = new Set(ranked.map(({ item }) => item.commit));
    const blameSet = new Set(blamed);
    const candidates = [
      ...history.commits
        .filter((commit) => blameSet.has(commit.commit))
        .map((item) => ({ item, score: Number.MAX_SAFE_INTEGER })),
      ...ranked,
      ...history.commits.filter((commit) => !rankedCommits.has(commit.commit)).map((item) => ({ item, score: 0 })),
    ]
      .filter(({ item }, index, all) => all.findIndex((candidate) => candidate.item.commit === item.commit) === index)
      .slice(0, 5);
    const evidence = await Promise.all(
      candidates.map(async ({ item, score }) => ({
        ...item,
        reason: blameSet.has(item.commit)
          ? ("blame" as const)
          : exact.has(item.commit) || [...exact].some((hash) => item.commit.startsWith(hash))
            ? ("exact_hash" as const)
            : score > 0
              ? ("bm25" as const)
              : ("recent_path_change" as const),
        score: score === Number.MAX_SAFE_INTEGER ? 0 : score,
        diffHunks: this.#boundedDiff(
          await this.runner.run(project.root, ["show", "--format=fuller", "--no-ext-diff", item.commit, "--", path]),
        ),
      })),
    );
    const limitations = [
      ...(status.shallow ? ["Git history is shallow and may omit earlier rationale."] : []),
      ...(status.workingTree === "dirty" ? ["Uncommitted changes are not represented in commit evidence."] : []),
      ...(evidence.some((commit) => commit.body === undefined)
        ? ["Some matching commits have no body explaining their rationale."]
        : []),
    ];
    return {
      path,
      ...(input.startLine === undefined || input.endLine === undefined
        ? {}
        : { requestedLines: { start: input.startLine, end: input.endLine } }),
      workingTree: status.workingTree ?? "clean",
      head: status.head ?? "",
      evidence,
      limitations,
    };
  }

  async #history(
    projectRoot: string,
    path: string,
    limit: number,
  ): Promise<{ commits: GitCommit[]; limitations: string[] }> {
    assertLimit(limit, 200);
    const args = ["log", "--follow", `--max-count=${limit}`, `--format=${LOG_FORMAT}`, "--name-only", "-z", "--", path];
    return { commits: parseLog(await this.runner.run(projectRoot, args)), limitations: [] };
  }

  async #safePath(project: Awaited<ReturnType<typeof resolveProjectPath>>, input: string): Promise<string> {
    const resolved = await resolveSafeFile(project, input);
    return resolved.slice(project.root.length + 1);
  }

  #boundedDiff(text: string): string[] {
    const clipped = text.slice(0, MAX_DIFF_BYTES).split("\n").slice(0, MAX_DIFF_LINES);
    return clipped.filter(
      (line) => line.startsWith("@@") || line.startsWith("+") || line.startsWith("-") || line.startsWith("diff "),
    );
  }
}
