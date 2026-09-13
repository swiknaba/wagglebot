import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RegistrySource } from "./source";

function root() {
  const dir = mkdtempSync(join("/tmp", "waggle-source-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  mkdirSync(join(dir, "company"));
  writeFileSync(join(dir, "company", "catalog.yaml"), "kind: User\nmetadata: {name: alice}\n");
  writeFileSync(join(dir, "tool_catalog.yaml"), "version: 1\ntitle: T\nfamilies: []\n");
  return dir;
}

test("retains the previous accepted source when refresh fails", async () => {
  const dir = root();
  const source = new RegistrySource({
    companyRoot: dir,
    sourceRevision: "a".repeat(40),
  });
  expect((await source.refresh()).ok).toBe(true);
  writeFileSync(join(dir, "tool_catalog.yaml"), "version: nope\n");
  const failed = await source.refresh();
  expect(failed.ok).toBe(false);
  expect(source.current()?.sourceRevision).toBe("a".repeat(40));
});
