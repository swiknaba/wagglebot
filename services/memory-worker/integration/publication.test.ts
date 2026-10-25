import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitRevisionVerifier, PublicationServiceError } from "../src/publication";

const directories: string[] = [];
const repository = "company/wagglebot-config";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wagglebot-publication-git-"));
  directories.push(directory);
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "memory-test@example.invalid");
  git(directory, "config", "user.name", "Memory Test");
  writeFileSync(join(directory, "knowledge.md"), "first\n");
  git(directory, "add", "knowledge.md");
  git(directory, "commit", "--quiet", "-m", "first");
  const first = git(directory, "rev-parse", "HEAD");
  writeFileSync(join(directory, "knowledge.md"), "second\n");
  git(directory, "commit", "--quiet", "-am", "second");
  const second = git(directory, "rev-parse", "HEAD");
  return { directory, first, second };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("verifies a commit exists and accepts only fast-forward source revisions", () => {
  const repo = fixture();
  const verifier = createGitRevisionVerifier({ [repository]: repo.directory });
  expect(verifier.assertCommit(repository, repo.first)).toBeUndefined();
  expect(verifier.assertFastForward(repository, repo.first, repo.second)).toBeUndefined();
  expect(() => verifier.assertFastForward(repository, repo.second, repo.first)).toThrow(
    expect.objectContaining({ code: "source_revision_regressed" }),
  );
  expect(() => verifier.assertCommit(repository, "f".repeat(40))).toThrow(PublicationServiceError);
});

test("rejects commits from unrelated histories", () => {
  const repo = fixture();
  const other = mkdtempSync(join(tmpdir(), "wagglebot-publication-other-"));
  directories.push(other);
  git(other, "init", "--quiet");
  git(other, "config", "user.email", "memory-test@example.invalid");
  git(other, "config", "user.name", "Memory Test");
  writeFileSync(join(other, "different.md"), "unrelated\n");
  git(other, "add", "different.md");
  git(other, "commit", "--quiet", "-m", "unrelated");
  const unrelated = git(other, "rev-parse", "HEAD");
  const verifier = createGitRevisionVerifier({ [repository]: repo.directory });
  expect(() => verifier.assertFastForward(repository, repo.first, unrelated)).toThrow(PublicationServiceError);
});

test("ambient Git repository overrides cannot redirect verification away from the trusted checkout", () => {
  const trusted = fixture();
  const unrelated = fixture();
  writeFileSync(join(unrelated.directory, "different.md"), "different history\n");
  git(unrelated.directory, "add", "different.md");
  git(unrelated.directory, "commit", "--quiet", "-m", "unrelated history");
  const unrelatedCommit = git(unrelated.directory, "rev-parse", "HEAD");
  const verifier = createGitRevisionVerifier({ [repository]: trusted.directory });
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = unrelated.directory;
  try {
    expect(verifier.assertCommit(repository, trusted.first)).toBeUndefined();
    expect(() => verifier.assertCommit(repository, unrelatedCommit)).toThrow(
      expect.objectContaining({ code: "source_revision_regressed" }),
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test("replacement refs cannot rewrite the trusted repository ancestry graph", () => {
  const repo = fixture();
  const tree = git(repo.directory, "rev-parse", `${repo.first}^{tree}`);
  const unrelated = git(repo.directory, "commit-tree", tree, "-m", "unrelated root");
  git(repo.directory, "replace", unrelated, repo.second);
  const verifier = createGitRevisionVerifier({ [repository]: repo.directory });
  expect(() => verifier.assertFastForward(repository, repo.first, unrelated)).toThrow(
    expect.objectContaining({ code: "source_revision_regressed" }),
  );
});
