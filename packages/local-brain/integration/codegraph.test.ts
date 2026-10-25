import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CodeGraphProvider } from "../src/codegraph/provider";
import { fixtureRepo } from "../src/memory/test-fixture";

const integrationTest = process.env.CODEGRAPH_INTEGRATION === "1" ? test : test.skip;

integrationTest("the pinned SDK persists and reopens a local CodeGraph index", async () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "entry.ts"),
    "import { service } from './service';\nexport const entry = () => service();\n",
  );
  writeFileSync(join(repo, "src", "service.ts"), "export const service = () => 'ready';\n");

  const first = new CodeGraphProvider();
  await first.initialize(repo);
  expect(existsSync(join(repo, ".codegraph", "codegraph.db"))).toBe(true);
  await first.close();

  const second = new CodeGraphProvider();
  const result = await second.explore({ projectRoot: repo, query: "entry service", maxNodes: 20, includeCode: true });
  await second.close();

  expect(process.env.CODEGRAPH_TELEMETRY).toBe("0");
  expect(result.state).toBe("ready");
  expect(result.nodes.length).toBeGreaterThan(0);
  expect(result.nodes.find((node) => node.name === "entry")?.snippet).toContain(
    "export const entry = () => service();",
  );
});

integrationTest(
  "the watcher incrementally indexes a changed local source file",
  async () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, "src"));
    const source = join(repo, "src", "service.ts");
    writeFileSync(source, "export const original = () => 'ready';\n");
    const provider = new CodeGraphProvider();
    await provider.initialize(repo);
    const database = join(repo, ".codegraph", "codegraph.db");

    writeFileSync(source, "export const replacement = () => 'updated';\n");
    let updated = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(250);
      const result = await provider.explore({
        projectRoot: repo,
        query: "replacement",
        maxNodes: 20,
        includeCode: false,
      });
      if (result.nodes.some((node) => node.name === "replacement")) {
        updated = true;
        break;
      }
    }
    await provider.close();

    expect(updated).toBe(true);
    expect(existsSync(database)).toBe(true);
  },
  10_000,
);

integrationTest("context retrieval leaves the current graph tables and checkout unchanged", async () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo, "src"));
  const source = join(repo, "src", "entry.ts");
  writeFileSync(source, "export const rotateSession = () => 'current';\n");
  const initializer = new CodeGraphProvider();
  await initializer.initialize(repo);
  await initializer.close();
  const databasePath = join(repo, ".codegraph", "codegraph.db");

  const snapshot = () => {
    const databaseUrl = new URL(pathToFileURL(databasePath).href);
    databaseUrl.searchParams.set("immutable", "1");
    const db = new Database(databaseUrl.href, { readonly: true, create: false });
    try {
      return ["nodes", "edges", "nodes_fts", "schema_versions"].map((table) => {
        try {
          return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
        } catch (error) {
          throw new Error(`${table}: ${error instanceof Error ? error.message : "snapshot failed"}`);
        }
      });
    } finally {
      db.close();
    }
  };
  const beforeTables = snapshot();
  const beforeSource = await Bun.file(source).text();
  const reader = new CodeGraphProvider();
  const context = await reader.exploreContext({
    projectRoot: repo,
    query: "rotateSession",
    maxNodes: 20,
    includeCode: true,
  });
  await reader.close();
  const afterTables = snapshot();
  const afterSource = await Bun.file(source).text();

  expect(context.nodes.some((node) => node.name === "rotateSession")).toBe(true);
  expect(afterTables).toEqual(beforeTables);
  expect(afterSource).toBe(beforeSource);
});
