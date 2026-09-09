import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "./project-root";

test("finds the Git root from a nested directory", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-repo-")));
  mkdirSync(join(repo, ".git"));
  const nested = join(repo, "a", "b");
  mkdirSync(nested, { recursive: true });
  const root = findProjectRoot(nested);
  expect(root).toBe(repo);
});

test("a .git file (worktree style) also counts as a Git root", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wgl-repo-")));
  writeFileSync(join(repo, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
  const root = findProjectRoot(repo);
  expect(root).toBe(repo);
});

test("throws outside any Git repository", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wgl-noGit-")));
  expect(() => findProjectRoot(outside)).toThrow(/Git repository/);
});
