import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isSecretPath, resolveProjectPath, resolveSafeFile } from "./path-policy";

const fixtureRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "wgl-local-brain-"));
  execFileSync("git", ["init", "--quiet", repo]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
  return repo;
};

test("rejects a symlink that leaves the Git root", async () => {
  const repo = fixtureRepo();
  const outside = mkdtempSync(join(tmpdir(), "wgl-outside-"));
  writeFileSync(join(outside, "private.txt"), "not repository data\n");
  symlinkSync(outside, join(repo, "escape"), "dir");

  await expect(resolveSafeFile(await resolveProjectPath(repo), "escape/private.txt")).rejects.toThrow(
    /outside Git root/,
  );
});

test("accepts canonical files inside the Git root", async () => {
  const repo = fixtureRepo();

  await expect(resolveSafeFile(await resolveProjectPath(repo), "src/index.ts")).resolves.toBe(
    realpathSync(join(repo, "src/index.ts")),
  );
});

test("rejects absolute, traversal, and secret paths", async () => {
  const repo = fixtureRepo();
  const project = await resolveProjectPath(repo);
  const outside = join(dirname(repo), `${basename(repo)}-outside.txt`);
  writeFileSync(outside, "not repository data\n");
  writeFileSync(join(repo, ".env"), "TOKEN=nope\n");
  mkdirSync(join(repo, "secrets"));
  writeFileSync(join(repo, "secrets", "key.txt"), "nope\n");

  await expect(resolveSafeFile(project, "/tmp/private.txt")).rejects.toThrow(/relative/);
  await expect(resolveSafeFile(project, `../${basename(outside)}`)).rejects.toThrow(/outside Git root/);
  await expect(resolveSafeFile(project, ".env")).rejects.toThrow(/forbidden/);
  await expect(resolveSafeFile(project, "secrets/key.txt")).rejects.toThrow(/forbidden/);
});

test("identifies every denied secret-path pattern", () => {
  for (const path of [
    ".env",
    ".env.local",
    "certs/server.pem",
    "certs/server.key",
    "credentials/token.txt",
    "secrets/key.txt",
  ]) {
    expect(isSecretPath(path)).toBe(true);
  }
  expect(isSecretPath("src/token-service.ts")).toBe(false);
});
