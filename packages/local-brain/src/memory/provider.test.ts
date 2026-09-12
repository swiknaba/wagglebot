import { expect, test } from "bun:test";
import { MarkdownMemoryProvider } from "./provider";
import { fixtureRepo, memory, writeMemory } from "./test-fixture";

test("search invalidates its cache when the file changes", async () => {
  const repo = fixtureRepo();
  const provider = new MarkdownMemoryProvider();
  writeMemory(repo, memory("TokenService owns SQLite rotation."));

  expect((await provider.search({ projectRoot: repo, query: "TokenService", limit: 5 })).length).toBeGreaterThan(0);
  writeMemory(repo, memory("PostgreSQL owns rotation."));
  expect((await provider.search({ projectRoot: repo, query: "TokenService", limit: 5 })).length).toBe(0);
});

test("returns current local text and heading provenance", async () => {
  const repo = fixtureRepo();
  const provider = new MarkdownMemoryProvider();
  writeMemory(repo, memory("TokenService owns rotation."));

  const [hit] = await provider.search({ projectRoot: repo, query: "Architecture", limit: 5 });
  expect(hit).toMatchObject({ path: ".agents/memory.md", headingPath: ["Architecture"] });
  expect(hit?.content).toContain("TokenService");
});

test("a missing file has no local-memory hits", async () => {
  const provider = new MarkdownMemoryProvider();
  expect(await provider.read(fixtureRepo())).toBeUndefined();
});
