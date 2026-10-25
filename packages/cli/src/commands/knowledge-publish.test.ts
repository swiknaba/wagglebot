import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKnowledgePublish } from "./knowledge-publish";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const env = { MEMORY_WORKER_URL: "https://memory.example.test", MEMORY_ADMIN_BEARER_TOKEN: "private-token" };
const source =
  "---\nwagglebot:\n  schemaVersion: 1\n  scope: domain:payments\n  owner: team-payments\n  kind: convention\n  title: Reviewed policy\n  confidence: high\n---\nPreamble\n# Policy\nUse the reviewed API.\n";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "wagglebot-publish-cli-"));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Publication Test");
  git("config", "user.email", "publication@example.invalid");
  writeFileSync(join(cwd, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(cwd, "knowledge.md"), source);
  git("add", ".");
  git("commit", "--quiet", "-m", "reviewed source");
  return { cwd, git, revision: git("rev-parse", "HEAD") };
}

test("publication uses only the selected committed bytes and creates stable retry requests", async () => {
  const repo = fixture();
  writeFileSync(join(repo.cwd, "knowledge.md"), "Uncommitted private working text");
  const payloads: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(
      await runKnowledgePublish({
        cwd: repo.cwd,
        env,
        args: [
          "publish",
          "knowledge.md",
          "--repository",
          "company/config",
          "--revision",
          repo.revision,
          "--operation-key",
          "publish-1",
        ],
        write: (line) => lines.push(line),
        fetch: async (url, init) => {
          const body = JSON.parse(String(init.body));
          expect(String(url)).toMatch(/^https:\/\/memory\.example\.test\/v1\/publications\/wglsrc_/);
          payloads.push(body);
          return Response.json({
            schemaVersion: 1,
            operationKey: body.operationKey,
            sourceKey: String(url).split("/").at(-1),
            revision: repo.revision,
            created: 2,
            updated: 0,
            invalidated: 0,
            unchanged: 0,
          });
        },
      }),
    ).toBe(0);
  }
  const replay = payloads[1];
  if (!replay) throw new Error("missing retry request");
  expect(payloads[0]).toEqual(replay);
  const firstChunks = payloads[0]?.chunks as Array<{ content: string }> | undefined;
  if (!firstChunks) throw new Error("missing first publication request");
  expect(firstChunks.map((chunk) => chunk.content).join("")).toBe("Preamble\n# Policy\nUse the reviewed API.\n");
  expect(JSON.stringify(payloads)).not.toContain("Uncommitted private");
  expect(lines.join("\n")).not.toContain("Use the reviewed API");
  expect(lines.join("\n")).not.toContain(repo.cwd);
  expect(lines.join("\n")).not.toContain("private-token");
  expect(repo.git("diff", "--name-only")).toBe("knowledge.md");
});

test("removal requires explicit retained identity and a commit where the source is absent", async () => {
  const repo = fixture();
  const args = [
    "publish",
    "knowledge.md",
    "--repository",
    "company/config",
    "--operation-key",
    "remove-1",
    "--remove",
    "--scope",
    "domain:payments",
    "--owner",
    "team-payments",
  ];
  let calls = 0;
  const invoke = () =>
    runKnowledgePublish({
      cwd: repo.cwd,
      env,
      args,
      write: () => {},
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          path: "knowledge.md",
          repository: "company/config",
          scope: { kind: "domain", name: "payments" },
          owner: "team-payments",
          chunks: [],
        });
        return Response.json({
          schemaVersion: 1,
          operationKey: "remove-1",
          sourceKey: "source",
          revision: body.revision,
          created: 0,
          updated: 0,
          invalidated: 2,
          unchanged: 0,
        });
      },
    });
  expect(await invoke()).toBe(1);
  expect(calls).toBe(0);
  repo.git("rm", "knowledge.md");
  repo.git("commit", "--quiet", "-m", "reviewed source removal");
  expect(await invoke()).toBe(0);
  expect(calls).toBe(1);
});

test("publication preserves company subdirectory support and literal source paths", async () => {
  const repo = fixture();
  mkdirSync(join(repo.cwd, "config"));
  repo.git("mv", "wagglebot.yaml", "config/wagglebot.yaml");
  repo.git("mv", "knowledge.md", "config/knowledge[1].md");
  repo.git("commit", "--quiet", "-m", "company subdirectory");
  expect(
    await runKnowledgePublish({
      cwd: join(repo.cwd, "config"),
      env,
      args: ["publish", "knowledge[1].md", "--repository", "company/config", "--operation-key", "subdir"],
      write: () => {},
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.path).toBe("config/knowledge[1].md");
        return Response.json({
          schemaVersion: 1,
          operationKey: "subdir",
          sourceKey: "source",
          revision: body.revision,
          created: 2,
          updated: 0,
          invalidated: 0,
          unchanged: 0,
        });
      },
    }),
  ).toBe(0);
});

test("ambient Git overrides cannot redirect publication and tracked symlinks are rejected", async () => {
  const repo = fixture();
  const other = fixture();
  writeFileSync(join(other.cwd, "knowledge.md"), source.replace("reviewed API", "unrelated API"));
  other.git("commit", "--quiet", "-am", "unrelated source");
  const args = ["publish", "knowledge.md", "--repository", "company/config", "--operation-key", "git-boundary"];
  let calls = 0;
  expect(
    await runKnowledgePublish({
      cwd: repo.cwd,
      env: {
        ...env,
        GIT_DIR: join(other.cwd, ".git"),
        GIT_WORK_TREE: other.cwd,
        GIT_OBJECT_DIRECTORY: join(other.cwd, ".git/objects"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: other.cwd,
      },
      args,
      write: () => {},
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        expect(body.revision).toBe(repo.revision);
        expect(JSON.stringify(body)).not.toContain("unrelated API");
        return Response.json({
          schemaVersion: 1,
          operationKey: "git-boundary",
          sourceKey: "source",
          revision: body.revision,
          created: 2,
          updated: 0,
          invalidated: 0,
          unchanged: 0,
        });
      },
    }),
  ).toBe(0);
  symlinkSync("knowledge.md", join(repo.cwd, "linked.md"));
  repo.git("add", "linked.md");
  repo.git("commit", "--quiet", "-m", "linked source");
  expect(
    await runKnowledgePublish({
      cwd: repo.cwd,
      env,
      args: ["publish", "linked.md", "--repository", "company/config", "--operation-key", "symlink"],
      write: () => {},
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    }),
  ).toBe(1);
  expect(calls).toBe(1);
});

test("publication rejects missing identity, unsafe paths and malformed committed sources without network or sensitive output", async () => {
  const repo = fixture();
  for (const args of [
    ["publish", "knowledge.md"],
    ["publish", "../knowledge.md", "--repository", "company/config", "--operation-key", "op"],
    ["publish", "knowledge.md", "--repository", "company/config", "--operation-key", "op", "--remove"],
  ]) {
    let calls = 0;
    expect(
      await runKnowledgePublish({
        cwd: repo.cwd,
        env,
        args,
        write: () => {},
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      }),
    ).toBe(2);
    expect(calls).toBe(0);
  }
  writeFileSync(join(repo.cwd, "knowledge.md"), "private malformed source");
  repo.git("commit", "--quiet", "-am", "invalid source");
  const lines: string[] = [];
  expect(
    await runKnowledgePublish({
      cwd: repo.cwd,
      env,
      args: ["publish", "knowledge.md", "--repository", "company/config", "--operation-key", "op"],
      write: (line) => lines.push(line),
      fetch: async () => {
        throw new Error("should not send");
      },
    }),
  ).toBe(1);
  expect(lines.join("\n")).not.toContain("private malformed source");
  expect(lines.join("\n")).not.toContain(repo.cwd);
});
