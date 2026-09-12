import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CodeGraphProvider } from "../src/codegraph/provider";
import { fixtureRepo } from "../src/memory/test-fixture";

test("the pinned SDK persists and reopens a local CodeGraph index", async () => {
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
});

test("the watcher incrementally indexes a changed local source file", async () => {
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
}, 10_000);
