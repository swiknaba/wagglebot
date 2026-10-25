import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { fixtureRepo } from "../memory/test-fixture";
import { resolveProjectRootKey } from "./root-key";

test("root key is stable for paths inside the same canonical Git root", async () => {
  const root = fixtureRepo();
  mkdirSync(`${root}/src`);
  const first = await resolveProjectRootKey(root);
  const second = await resolveProjectRootKey(`${root}/src`);
  expect(first.rootKey).toBe(second.rootKey);
  expect(first.rootKey).toMatch(/^rk_[a-f0-9]{32}$/u);
});

test("root key rejects non-repository paths", async () => {
  await expect(resolveProjectRootKey("/not/a/repository/path")).rejects.toThrow();
});
